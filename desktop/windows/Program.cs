using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OpenChatX.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private readonly RuntimeSupervisor _supervisor = new();
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly ToolStrip _toolbar = new() { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top };
    private readonly ToolStripButton _runtimeButton = new() { DisplayStyle = ToolStripItemDisplayStyle.Text };
    private readonly ToolStripDropDownButton _moreButton = new("More");
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 2000 };
    private RuntimeSnapshot _snapshot = new(false, false, false);
    private bool _webReady;

    public MainForm()
    {
        Text = "OpenChatX";
        Width = 1240;
        Height = 820;
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;

        _toolbar.Padding = new Padding(8, 4, 8, 4);
        _runtimeButton.Text = "Start Runtime";
        _runtimeButton.Click += async (_, _) => await ToggleRuntimeAsync();
        _moreButton.DropDownOpening += (_, _) => PopulateMoreMenu();
        _toolbar.Items.Add(new ToolStripLabel("OpenChatX") { Font = new Font("Segoe UI", 9F, FontStyle.Bold) });
        _toolbar.Items.Add(new ToolStripSeparator());
        _toolbar.Items.Add(_runtimeButton);
        _toolbar.Items.Add(_moreButton);

        Controls.Add(_webView);
        Controls.Add(_toolbar);

        Load += async (_, _) => await InitializeAsync();
        FormClosing += (_, _) => _supervisor.Stop();
        _timer.Tick += async (_, _) => await RefreshSnapshotAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            await _supervisor.PrepareStateAsync();
            var webViewEnvironment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: _supervisor.WebViewUserDataDirectory
            );
            await _webView.EnsureCoreWebView2Async(webViewEnvironment);
            _webReady = true;
            _webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                OpenExternal(args.Uri);
            };
            _webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) return;
                if (uri.IsLoopback) return;
                args.Cancel = true;
                OpenExternal(args.Uri);
            };
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                "OpenChatX could not initialize its embedded browser. Install or repair Microsoft Edge WebView2 Runtime.\n\n" + error.Message,
                "OpenChatX",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }

        ShowStartingPage();
        await _supervisor.StartAsync();
        await RefreshSnapshotAsync();
        _timer.Start();
    }

    private static void OpenExternal(string value)
    {
        try
        {
            Process.Start(new ProcessStartInfo(value) { UseShellExecute = true });
        }
        catch
        {
            // Ignore shell-open failures; navigation stays inside the app.
        }
    }

    private async Task ToggleRuntimeAsync()
    {
        if (_snapshot.Backend)
            _supervisor.Stop();
        else
            await _supervisor.StartAsync();

        await RefreshSnapshotAsync();
    }

    private async Task RefreshSnapshotAsync()
    {
        await _supervisor.MaintainRuntimeAsync();
        _snapshot = await _supervisor.SnapshotAsync();
        RenderSnapshot();
    }

    private void RenderSnapshot()
    {
        _runtimeButton.Text = _snapshot.Backend ? "Stop Runtime" : "Start Runtime";
        if (!_webReady) return;

        if (_snapshot.Backend)
        {
            var current = _webView.Source;
            if (current is null || current.Host != "127.0.0.1" || current.Port != 3333)
                _webView.Source = new Uri("http://127.0.0.1:3333/ui/");
        }
        else
        {
            ShowStartingPage();
        }
    }

    private void ShowStartingPage()
    {
        if (!_webReady) return;
        _webView.NavigateToString(
            """
            <!doctype html>
            <html>
              <body style="font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f7;color:#333">
                <div style="text-align:center">
                  <h2 style="font-weight:600">OpenChatX</h2>
                  <p>Starting local capability runtime…</p>
                </div>
              </body>
            </html>
            """
        );
    }

    private void PopulateMoreMenu()
    {
        _moreButton.DropDownItems.Clear();

        var restart = new ToolStripMenuItem("Restart Runtime") { Enabled = _snapshot.Backend };
        restart.Click += async (_, _) =>
        {
            await _supervisor.RestartAsync();
            await RefreshSnapshotAsync();
        };
        _moreButton.DropDownItems.Add(restart);

        var tunnel = new ToolStripMenuItem(_snapshot.Tunnel ? "Tunnel Connected" : "Connect Tunnel…")
        {
            Enabled = !_snapshot.Tunnel
        };
        tunnel.Click += async (_, _) => await ConfigureTunnelAsync();
        _moreButton.DropDownItems.Add(tunnel);

        _moreButton.DropDownItems.Add(new ToolStripSeparator());

        var logs = new ToolStripMenuItem("Open Logs");
        logs.Click += (_, _) => Process.Start(new ProcessStartInfo(_supervisor.LogsDirectory)
        {
            UseShellExecute = true
        });
        _moreButton.DropDownItems.Add(logs);
    }

    private async Task ConfigureTunnelAsync()
    {
        using var dialog = new TunnelSetupForm(_snapshot.TunnelProfile);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        try
        {
            await _supervisor.SetupTunnelAsync(dialog.TunnelId, dialog.ApiKey);
            await RefreshSnapshotAsync();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "Tunnel setup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

internal sealed class TunnelSetupForm : Form
{
    private readonly TextBox _tunnelId = new();
    private readonly TextBox _apiKey = new() { UseSystemPasswordChar = true };

    public string? TunnelId => _tunnelId.Text.Trim();
    public string ApiKey => _apiKey.Text.Trim();

    public TunnelSetupForm(bool hasProfile)
    {
        Text = "Connect OpenAI Secure MCP Tunnel";
        Width = 480;
        Height = hasProfile ? 220 : 280;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;

        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(20),
            ColumnCount = 1,
            RowCount = hasProfile ? 5 : 7,
            AutoSize = true
        };

        table.Controls.Add(new Label
        {
            Text = hasProfile
                ? "Enter the control-plane API key. It is stored in Windows Credential Manager."
                : "Enter the Tunnel ID and control-plane API key. The API key is stored in Windows Credential Manager.",
            AutoSize = true,
            MaximumSize = new Size(420, 0)
        });

        if (!hasProfile)
        {
            table.Controls.Add(new Label { Text = "Tunnel ID", AutoSize = true });
            _tunnelId.Dock = DockStyle.Top;
            _tunnelId.PlaceholderText = "tun_…";
            table.Controls.Add(_tunnelId);
        }

        table.Controls.Add(new Label { Text = "Control-plane API key", AutoSize = true });
        _apiKey.Dock = DockStyle.Top;
        _apiKey.PlaceholderText = "API key";
        table.Controls.Add(_apiKey);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true
        };
        var connect = new Button { Text = "Connect", DialogResult = DialogResult.OK, AutoSize = true };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        actions.Controls.Add(connect);
        actions.Controls.Add(cancel);
        table.Controls.Add(actions);

        AcceptButton = connect;
        CancelButton = cancel;
        Controls.Add(table);
    }
}

internal readonly record struct RuntimeSnapshot(bool Backend, bool Tunnel, bool TunnelProfile);

internal sealed class RuntimeSupervisor
{
    private static readonly Uri BackendHealth = new("http://127.0.0.1:3333/healthz");
    private static readonly Uri TunnelHealth = new("http://127.0.0.1:8080/readyz");
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMilliseconds(700) };
    private readonly string _runtimeRoot;
    private readonly string _nodeExecutable;
    private readonly string _tunnelExecutable;
    private readonly string _appSupport;
    private readonly string _profileDirectory;
    private Process? _backendProcess;
    private Process? _tunnelProcess;
    private bool _backendOwned;
    private bool _tunnelOwned;
    private readonly SemaphoreSlim _maintenanceGate = new(1, 1);

    public string LogsDirectory { get; }
    public string WebViewUserDataDirectory { get; }

    public RuntimeSupervisor()
    {
        _runtimeRoot = Path.Combine(AppContext.BaseDirectory, "runtime");
        _nodeExecutable = Path.Combine(_runtimeRoot, "bin", "node.exe");
        _tunnelExecutable = Path.Combine(_runtimeRoot, "bin", "tunnel-client.exe");
        _appSupport = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenChatX"
        );
        LogsDirectory = Path.Combine(_appSupport, "logs");
        WebViewUserDataDirectory = Path.Combine(_appSupport, "webview2");
        _profileDirectory = Path.Combine(_appSupport, "tunnel-profiles");
    }

    public async Task PrepareStateAsync()
    {
        var configDirectory = Path.Combine(_appSupport, "config");
        var toolboxDirectory = Path.Combine(_appSupport, "toolboxes");
        Directory.CreateDirectory(configDirectory);
        Directory.CreateDirectory(LogsDirectory);
        Directory.CreateDirectory(_profileDirectory);

        CopyIfMissing(
            Path.Combine(_runtimeRoot, ".openchatx", "config.toml"),
            Path.Combine(configDirectory, "openchatx.toml")
        );
        CopyIfMissing(
            Path.Combine(_runtimeRoot, "defaults", "mcp-servers.json"),
            Path.Combine(configDirectory, "mcp-servers.json")
        );
        CopyIfMissing(
            Path.Combine(_runtimeRoot, "defaults", "subagents.json"),
            Path.Combine(configDirectory, "subagents.json")
        );
        if (!Directory.Exists(toolboxDirectory))
            CopyDirectory(Path.Combine(_runtimeRoot, "defaults", "toolboxes"), toolboxDirectory);

        await Task.CompletedTask;
    }

    public async Task StartAsync()
    {
        await MaintainRuntimeAsync();
    }

    public async Task MaintainRuntimeAsync()
    {
        if (!await _maintenanceGate.WaitAsync(0)) return;
        try
        {
            await PrepareStateAsync();
            if (!await IsHealthyAsync(BackendHealth) && (_backendProcess?.HasExited ?? true))
            {
                StartBackend();
                await WaitUntilHealthyAsync(BackendHealth, 50);
            }

            if (HasTunnelProfile() && !await IsHealthyAsync(TunnelHealth) && (_tunnelProcess?.HasExited ?? true))
                StartTunnel();
        }
        catch (Exception error)
        {
            AppendDesktopLog("Runtime maintenance failed: " + error.Message);
        }
        finally
        {
            _maintenanceGate.Release();
        }
    }

    public async Task<RuntimeSnapshot> SnapshotAsync()
    {
        return new RuntimeSnapshot(
            await IsHealthyAsync(BackendHealth),
            await IsHealthyAsync(TunnelHealth),
            HasTunnelProfile()
        );
    }

    public void Stop()
    {
        StopProcess(ref _tunnelProcess, ref _tunnelOwned);
        StopProcess(ref _backendProcess, ref _backendOwned);
    }

    public async Task RestartAsync()
    {
        Stop();
        await Task.Delay(400);
        await StartAsync();
    }

    public async Task SetupTunnelAsync(string? tunnelId, string apiKey)
    {
        var trimmedKey = apiKey.Trim();
        if (trimmedKey.Length == 0) throw new InvalidOperationException("Control-plane API key is required.");

        WindowsCredentialStore.Save("OpenChatX/CONTROL_PLANE_API_KEY", trimmedKey);

        if (!HasTunnelProfile())
        {
            var trimmedTunnelId = tunnelId?.Trim() ?? "";
            if (trimmedTunnelId.Length == 0) throw new InvalidOperationException("Tunnel ID is required for first-time setup.");

            var exitCode = await RunAndWaitAsync(
                _tunnelExecutable,
                new[]
                {
                    "init",
                    "--profile-dir", _profileDirectory,
                    "--profile", "openchatx",
                    "--tunnel-id", trimmedTunnelId,
                    "--mcp-server-url", "http://127.0.0.1:3333/mcp",
                    "--health-listen-addr", "127.0.0.1:8080",
                    "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
                    "--force"
                },
                RuntimeEnvironment(trimmedKey)
            );
            if (exitCode != 0) throw new InvalidOperationException($"tunnel-client init exited with code {exitCode}.");
        }

        if (!await IsHealthyAsync(TunnelHealth)) StartTunnel();
    }

    private void StartBackend()
    {
        if (_backendProcess is { HasExited: false }) return;

        var configDirectory = Path.Combine(_appSupport, "config");
        var startInfo = NewProcessStartInfo(
            _nodeExecutable,
            new[] { Path.Combine(_runtimeRoot, "dist", "index.js") },
            Path.Combine(LogsDirectory, "runtime.log")
        );
        startInfo.WorkingDirectory = _runtimeRoot;
        ApplyEnvironment(startInfo, RuntimeEnvironment());
        startInfo.Environment["OPENCHATX_PUBLIC_CONFIG"] = Path.Combine(configDirectory, "openchatx.toml");
        startInfo.Environment["OPENCHATX_EXTERNAL_MCP_CONFIG"] = Path.Combine(configDirectory, "mcp-servers.json");
        startInfo.Environment["OPENCHATX_SUBAGENT_CONFIG"] = Path.Combine(configDirectory, "subagents.json");
        startInfo.Environment["OPENCHATX_TOOLBOX_ROOT"] = Path.Combine(_appSupport, "toolboxes");
        startInfo.Environment["OPENCHATX_AUDIT_LOG"] = Path.Combine(LogsDirectory, "agent-commands.yaml");

        _backendProcess = StartLoggedProcess(startInfo, Path.Combine(LogsDirectory, "runtime.log"));
        _backendOwned = true;
        AppendDesktopLog($"Started OpenChatX runtime pid={_backendProcess.Id}");
    }

    private void StartTunnel()
    {
        if (_tunnelProcess is { HasExited: false }) return;

        var startInfo = NewProcessStartInfo(
            _tunnelExecutable,
            new[]
            {
                "run",
                "--profile-dir", _profileDirectory,
                "--profile", "openchatx",
                "--health.listen-addr", "127.0.0.1:8080"
            },
            Path.Combine(LogsDirectory, "tunnel.log")
        );
        startInfo.WorkingDirectory = _runtimeRoot;
        ApplyEnvironment(startInfo, RuntimeEnvironment(WindowsCredentialStore.Load("OpenChatX/CONTROL_PLANE_API_KEY")));

        _tunnelProcess = StartLoggedProcess(startInfo, Path.Combine(LogsDirectory, "tunnel.log"));
        _tunnelOwned = true;
        AppendDesktopLog($"Started tunnel-client pid={_tunnelProcess.Id}");
    }

    private ProcessStartInfo NewProcessStartInfo(string executable, IEnumerable<string> arguments, string logPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        var startInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        return startInfo;
    }

    private Process StartLoggedProcess(ProcessStartInfo startInfo, string logPath)
    {
        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) =>
        {
            if (args.Data is not null) File.AppendAllText(logPath, args.Data + Environment.NewLine);
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is not null) File.AppendAllText(logPath, args.Data + Environment.NewLine);
        };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private bool HasTunnelProfile()
    {
        if (!File.Exists(_tunnelExecutable)) return false;
        try
        {
            var info = new ProcessStartInfo(_tunnelExecutable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            info.ArgumentList.Add("profiles");
            info.ArgumentList.Add("list");
            info.ArgumentList.Add("--profile-dir");
            info.ArgumentList.Add(_profileDirectory);
            using var process = Process.Start(info);
            if (process is null) return false;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(3000);
            return process.ExitCode == 0 &&
                   output.Split('\n').Any(line => line.Split('\t').FirstOrDefault()?.Trim() == "openchatx");
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> IsHealthyAsync(Uri uri)
    {
        try
        {
            using var response = await _http.GetAsync(uri);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> WaitUntilHealthyAsync(Uri uri, int attempts)
    {
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            if (await IsHealthyAsync(uri)) return true;
            await Task.Delay(200);
        }
        return false;
    }

    private Dictionary<string, string?> RuntimeEnvironment(string? apiKey = null)
    {
        var environment = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => entry.Value?.ToString());

        var bundledBin = Path.Combine(_runtimeRoot, "bin");
        var inherited = environment.GetValueOrDefault("PATH") ?? "";
        environment["PATH"] = bundledBin + Path.PathSeparator + inherited;
        environment["OPENCHATX_DESKTOP"] = "1";
        if (!string.IsNullOrWhiteSpace(apiKey))
            environment["CONTROL_PLANE_API_KEY"] = apiKey;
        else
            environment.Remove("CONTROL_PLANE_API_KEY");

        return environment;
    }

    private static void ApplyEnvironment(ProcessStartInfo startInfo, Dictionary<string, string?> environment)
    {
        startInfo.Environment.Clear();
        foreach (var (key, value) in environment)
        {
            if (value is not null) startInfo.Environment[key] = value;
        }
    }

    private async Task<int> RunAndWaitAsync(string executable, IEnumerable<string> arguments, Dictionary<string, string?> environment)
    {
        var logPath = Path.Combine(LogsDirectory, "tunnel.log");
        var startInfo = NewProcessStartInfo(executable, arguments, logPath);
        startInfo.WorkingDirectory = _runtimeRoot;
        ApplyEnvironment(startInfo, environment);
        using var process = StartLoggedProcess(startInfo, logPath);
        await process.WaitForExitAsync();
        return process.ExitCode;
    }

    private void StopProcess(ref Process? process, ref bool owned)
    {
        if (!owned || process is null)
        {
            process = null;
            owned = false;
            return;
        }

        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            process.WaitForExit(3000);
        }
        catch
        {
            // Best effort on app shutdown.
        }
        finally
        {
            process.Dispose();
            process = null;
            owned = false;
        }
    }

    private void AppendDesktopLog(string message)
    {
        Directory.CreateDirectory(LogsDirectory);
        File.AppendAllText(
            Path.Combine(LogsDirectory, "desktop.log"),
            $"[{DateTimeOffset.UtcNow:O}] {message}{Environment.NewLine}"
        );
    }

    private static void CopyIfMissing(string source, string destination)
    {
        if (File.Exists(destination)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Copy(source, destination);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: false);
        }
    }
}

internal static class WindowsCredentialStore
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string? Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static void Save(string target, string secret)
    {
        var bytes = Encoding.Unicode.GetBytes(secret);
        var blob = Marshal.AllocCoTaskMem(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = Environment.UserName
            };
            if (!CredWrite(ref credential, 0))
                throw new InvalidOperationException($"Could not save Windows credential ({Marshal.GetLastWin32Error()}).");
        }
        finally
        {
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeCoTaskMem(blob);
        }
    }

    public static string? Load(string target)
    {
        if (!CredRead(target, CredTypeGeneric, 0, out var credentialPtr)) return null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(credentialPtr);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
            return Marshal.PtrToStringUni(
                credential.CredentialBlob,
                checked((int)credential.CredentialBlobSize / sizeof(char))
            );
        }
        finally
        {
            CredFree(credentialPtr);
        }
    }
}
