// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyaser

// 苔室的共享内存桥：moss-server 的 component session 把张量放在 Windows 命名映射里，
// Node 没有 mmap 的入口，所以借这个小程序按字节搬运。
//
// 协议：stdin 一行一条命令，stdout 一行一个 JSON 结果。
//   probe <name>                         读头部（magic / version / bytes / payload 偏移 / token）
//   read  <name> <offset> <length> <file> 从区域读到文件
//   write <name> <offset> <file>          从文件写进区域
//
// 只做字节搬运与头部校验，不解释张量。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;

internal static class ShmBridge
{
    private static MemoryMappedFile mapping;
    private static MemoryMappedViewAccessor view;
    private static string currentName;
    private static long currentBytes;

    private static void Main()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim().TrimStart('\uFEFF').Trim();
            if (line.Length == 0) continue;
            try
            {
                Console.WriteLine(Handle(line));
            }
            catch (Exception error)
            {
                Console.WriteLine(Fail(error.Message));
            }
        }
        Close();
    }

    private static string Handle(string line)
    {
        string[] parts = SplitArgs(line);
        if (parts.Length == 0) return Fail("empty command");
        switch (parts[0])
        {
            case "probe":
                if (parts.Length < 2) return Fail("probe needs a region name");
                return Probe(parts[1]);
            case "read":
                if (parts.Length < 5) return Fail("read needs name offset length file");
                return Read(parts[1], parts[2], parts[3], parts[4]);
            case "write":
                if (parts.Length < 4) return Fail("write needs name offset file");
                return Write(parts[1], parts[2], parts[3]);
            case "close":
                Close();
                return "{\"ok\":true}";
            default:
                return Fail("unknown command " + parts[0]);
        }
    }

    private static string Probe(string name)
    {
        Attach(name);
        byte[] header = new byte[64];
        view.ReadArray(0, header, 0, header.Length);
        string magic = Encoding.ASCII.GetString(header, 0, 8);
        if (magic != "MOSSSHM\0") return Fail("not a moss shared region (magic)");
        uint version = BitConverter.ToUInt32(header, 8);
        uint pid = BitConverter.ToUInt32(header, 12);
        string token = ToHex(header, 16, 16);
        ulong bytes = BitConverter.ToUInt64(header, 32);
        ulong payload = BitConverter.ToUInt64(header, 40);
        return "{\"ok\":true,\"version\":" + version.ToString(CultureInfo.InvariantCulture)
            + ",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture)
            + ",\"token\":\"" + token + "\""
            + ",\"bytes\":" + bytes.ToString(CultureInfo.InvariantCulture)
            + ",\"payload\":" + payload.ToString(CultureInfo.InvariantCulture)
            + ",\"mapped\":" + currentBytes.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static string Read(string name, string offsetText, string lengthText, string file)
    {
        Attach(name);
        long offset = ParseLong(offsetText, "offset");
        long length = ParseLong(lengthText, "length");
        if (offset < 0 || length < 0) return Fail("offset and length must be non-negative");
        if (offset + length > currentBytes) return Fail("read past the end of the region");
        byte[] buffer = new byte[length];
        view.ReadArray(offset, buffer, 0, (int)length);
        File.WriteAllBytes(file, buffer);
        return "{\"ok\":true,\"bytes\":" + length.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static string Write(string name, string offsetText, string file)
    {
        Attach(name);
        long offset = ParseLong(offsetText, "offset");
        if (offset < 0) return Fail("offset must be non-negative");
        byte[] data = File.ReadAllBytes(file);
        if (offset + data.Length > currentBytes) return Fail("write past the end of the region");
        view.WriteArray(offset, data, 0, data.Length);
        view.Flush();
        return "{\"ok\":true,\"bytes\":" + data.Length.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static string[] SplitArgs(string line)
    {
        List<string> parts = new List<string>();
        StringBuilder current = new StringBuilder();
        bool quoted = false;
        foreach (char c in line)
        {
            if (c == '"') { quoted = !quoted; continue; }
            if (!quoted && (c == ' ' || c == '\t'))
            {
                if (current.Length > 0) { parts.Add(current.ToString()); current.Clear(); }
                continue;
            }
            current.Append(c);
        }
        if (current.Length > 0) parts.Add(current.ToString());
        return parts.ToArray();
    }

    private static void Attach(string name)
    {
        if (view != null && currentName == name) return;
        Close();
        mapping = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.ReadWrite);
        view = mapping.CreateViewAccessor(0, 0, MemoryMappedFileAccess.ReadWrite);
        currentBytes = view.Capacity;
        currentName = name;
    }

    private static void Close()
    {
        if (view != null)
        {
            view.Dispose();
            view = null;
        }
        if (mapping != null)
        {
            mapping.Dispose();
            mapping = null;
        }
        currentName = null;
        currentBytes = 0;
    }

    private static long ParseLong(string text, string label)
    {
        long value;
        if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
        {
            throw new ArgumentException("bad " + label + ": " + text);
        }
        return value;
    }

    private static string ToHex(byte[] data, int start, int count)
    {
        StringBuilder builder = new StringBuilder(count * 2);
        for (int i = 0; i < count; i++) builder.Append(data[start + i].ToString("x2", CultureInfo.InvariantCulture));
        return builder.ToString();
    }

    private static string Fail(string message)
    {
        return "{\"ok\":false,\"error\":\"" + message.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
    }
}
