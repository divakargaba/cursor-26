// UIAutomation helper — compiled on first use by computer.js
// Enumerates interactive UI elements of the foreground window using Windows UIAutomation API.
// Outputs a JSON array of {name, type, x, y, w, h, enabled} to stdout.
//
// Compile: csc.exe /nologo /optimize /out:data\uia-helper.exe /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll /reference:WindowsBase.dll src\uia-helper.cs

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

class UIAHelper
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);

    static string EscapeJson(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        // Strip control characters first, then escape JSON special chars
        s = Regex.Replace(s, @"[\u0000-\u001f\u007f-\u009f]", " ");
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static readonly string[] SKIP_TYPES = {
        "Pane", "Group", "Custom", "Separator", "Thumb",
        "ScrollBar", "TitleBar", "Window", "Image"
    };

    static void Main(string[] args)
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
            {
                Console.Write("{\"window\":\"\",\"elements\":[]}");
                return;
            }

            var titleSb = new StringBuilder(256);
            GetWindowText(hwnd, titleSb, 256);
            string windowTitle = EscapeJson(titleSb.ToString());

            AutomationElement root;
            try
            {
                root = AutomationElement.FromHandle(hwnd);
            }
            catch
            {
                Console.Write("{\"window\":\"" + windowTitle + "\",\"elements\":[]}");
                return;
            }

            AutomationElementCollection all;
            try
            {
                all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            }
            catch
            {
                Console.Write("{\"window\":\"" + windowTitle + "\",\"elements\":[]}");
                return;
            }

            var sb = new StringBuilder(4096);
            sb.Append("{\"window\":\"").Append(windowTitle).Append("\",\"elements\":[");

            bool first = true;
            int count = 0;
            int MAX = 80;

            foreach (AutomationElement el in all)
            {
                if (count >= MAX) break;
                try
                {
                    var rect = el.Current.BoundingRectangle;
                    if (rect.IsEmpty || double.IsInfinity(rect.X) || double.IsInfinity(rect.Y))
                        continue;
                    if (rect.Width < 5 || rect.Height < 5)
                        continue;

                    string type = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");

                    // Skip non-interactive types
                    bool skip = false;
                    foreach (var st in SKIP_TYPES)
                    {
                        if (type == st) { skip = true; break; }
                    }
                    if (skip) continue;

                    string name = EscapeJson(el.Current.Name ?? "");
                    if (name.Length > 100)
                        name = name.Substring(0, 100);

                    bool enabled = el.Current.IsEnabled;

                    if (!first) sb.Append(",");
                    sb.Append("{\"name\":\"").Append(name)
                      .Append("\",\"type\":\"").Append(type)
                      .Append("\",\"x\":").Append((int)(rect.X + rect.Width / 2))
                      .Append(",\"y\":").Append((int)(rect.Y + rect.Height / 2))
                      .Append(",\"w\":").Append((int)rect.Width)
                      .Append(",\"h\":").Append((int)rect.Height)
                      .Append(",\"enabled\":").Append(enabled ? "true" : "false")
                      .Append("}");
                    first = false;
                    count++;
                }
                catch { /* skip elements that fail */ }
            }

            sb.Append("]}");
            // Final safety: strip ANY control characters from the entire JSON output
            string output = Regex.Replace(sb.ToString(), @"[\x00-\x1f]", "");
            Console.Write(output);
        }
        catch (Exception ex)
        {
            Console.Error.Write(ex.Message);
            Console.Write("{\"window\":\"\",\"elements\":[]}");
        }
    }
}
