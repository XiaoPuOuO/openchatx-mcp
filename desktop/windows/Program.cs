using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OpenChatX.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm());
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "OpenChatX could not start.\n\n" + error.Message,
                "OpenChatX",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}

internal sealed class MainForm : Form
{
    private static readonly TimeSpan WebViewInitializationTimeout = TimeSpan.FromSeconds(15);
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

        Shown += async (_, _) => await InitializeAsync();
        FormClosing += (_, _) => _supervisor.Stop();
        _timer.Tick += async (_, _) => await RefreshSnapshotAsync();
    }

    private async Task InitializeAsync()
    {
        _supervisor.LogStartupStage("window-shown");
        _timer.Start();
        _ = StartRuntimeInBackgroundAsync();

        try
        {
            _supervisor.LogStartupStage("webview-environment-start");
            var webViewEnvironment = await CoreWebView2Environment
                .CreateAsync(
                    browserExecutableFolder: null,
                    userDataFolder: _supervisor.WebViewUserDataDirectory
                )
                .WaitAsync(WebViewInitializationTimeout);
            _supervisor.LogStartupStage("webview-environment-ready");
            _supervisor.LogStartupStage("webview-initialize-start");
            await _webView
                .EnsureCoreWebView2Async(webViewEnvironment)
                .WaitAsync(WebViewInitializationTimeout);
            _webReady = true;
            _supervisor.LogStartupStage("webview-ready");
            _webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (GetNavigationDisposition(args.Uri) == NavigationDisposition.External)
                    OpenExternal(args.Uri);
            };
            _webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                switch (GetNavigationDisposition(args.Uri))
                {
                    case NavigationDisposition.Internal:
                        return;
                    case NavigationDisposition.External:
                        args.Cancel = true;
                        OpenExternal(args.Uri);
                        return;
                    default:
                        args.Cancel = true;
                        return;
                }
            };
            ShowStartingPage();
        }
        catch (TimeoutException)
        {
            _supervisor.LogStartupStage("webview-timeout");
            OfferIsolatedDataRecovery(
                "OpenChatX's embedded browser did not initialize within 15 seconds."
            );
        }
        catch (Exception error)
        {
            _supervisor.LogStartupStage("webview-failed", error.GetType().Name);
            OfferIsolatedDataRecovery(
                "OpenChatX could not initialize its embedded browser.\n\n" + error.Message
            );
        }

        await UpdateSnapshotAsync();
    }

    private async Task StartRuntimeInBackgroundAsync()
    {
        _supervisor.LogStartupStage("runtime-start");
        try
        {
            await Task.Run(() => _supervisor.StartAsync());
            _supervisor.LogStartupStage("runtime-start-complete");
        }
        catch (Exception error)
        {
            _supervisor.LogStartupStage("runtime-start-failed", error.GetType().Name);
        }

        if (!IsDisposed && IsHandleCreated)
            BeginInvoke(async () => await UpdateSnapshotAsync());
    }

    private void OfferIsolatedDataRecovery(string reason)
    {
        var choice = MessageBox.Show(
            this,
            reason +
            "\n\nThe local OpenChatX runtime will continue independently of the browser." +
            "\n\nRestart once with a fresh isolated application-data directory? Existing data will not be deleted." +
            "\n\nIf the isolated restart also fails, install or repair Microsoft Edge WebView2 Runtime.",
            "OpenChatX browser recovery",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning
        );
        if (choice != DialogResult.Yes) return;

        try
        {
            _supervisor.RestartWithIsolatedAppData();
            Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                "Could not start the isolated recovery instance.\n\n" + error.Message,
                "OpenChatX",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
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

    internal static NavigationDisposition GetNavigationDisposition(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return NavigationDisposition.Blocked;
        if (uri.IsLoopback && uri.Scheme is "http" or "https") return NavigationDisposition.Internal;
        if (uri.Scheme is "data" or "about" or "blob") return NavigationDisposition.Internal;
        if (uri.Scheme is "http" or "https" or "mailto") return NavigationDisposition.External;
        return NavigationDisposition.Blocked;
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
        await UpdateSnapshotAsync();
    }

    private async Task UpdateSnapshotAsync()
    {
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
            var dashboard = _supervisor.DashboardUrl;
            if (current is null || current.Host != dashboard.Host || current.Port != dashboard.Port)
                _webView.Source = dashboard;
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

internal enum NavigationDisposition
{
    Internal,
    External,
    Blocked
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
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(480, 0);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;

        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            Padding = new Padding(20),
            ColumnCount = 1,
            RowCount = hasProfile ? 5 : 7,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink
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
    private const int DefaultRuntimePort = 8001;
    private const int DefaultTunnelHealthPort = 8080;
    private const string DefaultTunnelProfile = "openchatx";
    private static readonly TimeSpan TunnelProfileProbeTimeout = TimeSpan.FromSeconds(3);
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
    private readonly SemaphoreSlim _statePreparationGate = new(1, 1);
    private readonly object _logWriteGate = new();
    private bool _statePrepared;
    private DateTimeOffset _nextTunnelStartAllowedAt = DateTimeOffset.MinValue;
    private static readonly TimeSpan TunnelRestartBackoff = TimeSpan.FromSeconds(10);

    public string LogsDirectory { get; }
    public string WebViewUserDataDirectory { get; }
    public Uri DashboardUrl => new($"http://127.0.0.1:{RuntimePort}/ui/");
    private Uri BackendHealth => new($"http://127.0.0.1:{RuntimePort}/healthz");
    private Uri TunnelHealth => new($"http://127.0.0.1:{TunnelHealthPort}/health?details=true");
    private string McpServerUrl => $"http://127.0.0.1:{RuntimePort}/mcp";
    private string TunnelHealthListenAddress => $"127.0.0.1:{TunnelHealthPort}";
    private string TunnelProfile => ReadConfiguredString("tunnel", "profile", DefaultTunnelProfile);

    public RuntimeSupervisor()
    {
        _runtimeRoot = Path.Combine(AppContext.BaseDirectory, "runtime");
        _nodeExecutable = Path.Combine(_runtimeRoot, "bin", "node.exe");
        _tunnelExecutable = Path.Combine(_runtimeRoot, "bin", "tunnel-client.exe");
        _appSupport = ResolveAppSupportDirectory();
        LogsDirectory = Path.Combine(_appSupport, "logs");
        WebViewUserDataDirectory = Path.Combine(_appSupport, "webview2");
        _profileDirectory = Path.Combine(_appSupport, "tunnel-profiles");
        LogStartupStage("supervisor-created", Environment.GetEnvironmentVariable("OPENCHATX_APP_DATA") is null ? "default-data" : "custom-data");
    }

    private static string ResolveAppSupportDirectory()
    {
        var configured = Environment.GetEnvironmentVariable("OPENCHATX_APP_DATA")?.Trim();
        if (!string.IsNullOrEmpty(configured))
        {
            if (!Path.IsPathFullyQualified(configured))
                throw new InvalidOperationException("OPENCHATX_APP_DATA must be an absolute path.");
            return Path.GetFullPath(configured);
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenChatX"
        );
    }

    public void RestartWithIsolatedAppData()
    {
        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
            throw new InvalidOperationException("Could not resolve the OpenChatX executable path.");

        var recoveryRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenChatX-Recovery",
            $"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}"
        );
        Directory.CreateDirectory(recoveryRoot);

        var startInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = AppContext.BaseDirectory
        };
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
            startInfo.Environment[(string)entry.Key] = entry.Value?.ToString();
        startInfo.Environment["OPENCHATX_APP_DATA"] = recoveryRoot;
        Process.Start(startInfo);
    }

    public void LogStartupStage(string stage, string? detail = null)
    {
        AppendDesktopLog(
            detail is null
                ? $"startup stage={stage}"
                : $"startup stage={stage} detail={detail}"
        );
    }

    public async Task PrepareStateAsync()
    {
        await _statePreparationGate.WaitAsync();
        try
        {
            if (_statePrepared) return;

            var configDirectory = Path.Combine(_appSupport, "config");
            var toolboxDirectory = Path.Combine(_appSupport, "toolboxes");
            Directory.CreateDirectory(configDirectory);
            Directory.CreateDirectory(LogsDirectory);
            Directory.CreateDirectory(_profileDirectory);
            MigrateLegacyTunnelProfile();
            MigrateEnvironmentTunnelCredential();

            var publicConfigPath = Path.Combine(configDirectory, "openchatx.toml");
            CopyIfMissing(
                Path.Combine(_runtimeRoot, ".openchatx", "config.toml"),
                publicConfigPath
            );
            MigrateLegacyRuntimePort(publicConfigPath);
            CopyIfMissing(
                Path.Combine(_runtimeRoot, "defaults", "mcp-servers.json"),
                Path.Combine(configDirectory, "mcp-servers.json")
            );
            CopyIfMissing(
                Path.Combine(_runtimeRoot, "defaults", "subagents.json"),
                Path.Combine(configDirectory, "subagents.json")
            );
            SyncDefaultToolboxes(Path.Combine(_runtimeRoot, "defaults", "toolboxes"), toolboxDirectory);
            _statePrepared = true;
        }
        finally
        {
            _statePreparationGate.Release();
        }
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
                LogStartupStage("runtime-process-start");
                StartBackend();
                if (await WaitUntilHealthyAsync(BackendHealth, 50))
                    LogStartupStage("runtime-healthy");
                else
                    LogStartupStage("runtime-health-timeout");
            }

            if (await HasTunnelProfileAsync() &&
                !await IsTunnelRunningAsync() &&
                (_tunnelProcess?.HasExited ?? true) &&
                DateTimeOffset.UtcNow >= _nextTunnelStartAllowedAt)
            {
                LogStartupStage("tunnel-process-start");
                StartTunnel();
            }
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
            await IsTunnelHealthyAsync(),
            await HasTunnelProfileAsync()
        );
    }

    public void Stop()
    {
        StopProcess(ref _tunnelProcess, ref _tunnelOwned);
        StopProcess(ref _backendProcess, ref _backendOwned);
        _nextTunnelStartAllowedAt = DateTimeOffset.MinValue;
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

        if (!await HasTunnelProfileAsync())
        {
            var trimmedTunnelId = tunnelId?.Trim() ?? "";
            if (trimmedTunnelId.Length == 0) throw new InvalidOperationException("Tunnel ID is required for first-time setup.");

            var exitCode = await RunAndWaitAsync(
                _tunnelExecutable,
                new[]
                {
                    "init",
                    "--profile-dir", _profileDirectory,
                    "--profile", TunnelProfile,
                    "--tunnel-id", trimmedTunnelId,
                    "--mcp-server-url", McpServerUrl,
                    "--health-listen-addr", TunnelHealthListenAddress,
                    "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
                    "--force"
                },
                RuntimeEnvironment(trimmedKey, includeTunnelKey: true)
            );
            if (exitCode != 0) throw new InvalidOperationException($"tunnel-client init exited with code {exitCode}.");
        }

        if (!await IsTunnelRunningAsync()) StartTunnel();
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
                "--profile", TunnelProfile,
                "--mcp.server-url", $"url={McpServerUrl}",
                "--health.listen-addr", TunnelHealthListenAddress
            },
            Path.Combine(LogsDirectory, "tunnel.log")
        );
        startInfo.WorkingDirectory = _runtimeRoot;
        ApplyEnvironment(
            startInfo,
            RuntimeEnvironment(
                WindowsCredentialStore.Load("OpenChatX/CONTROL_PLANE_API_KEY"),
                includeTunnelKey: true
            )
        );

        _nextTunnelStartAllowedAt = DateTimeOffset.UtcNow + TunnelRestartBackoff;
        _tunnelProcess = StartLoggedProcess(startInfo, Path.Combine(LogsDirectory, "tunnel.log"));
        _tunnelOwned = true;
        AppendDesktopLog($"Started tunnel-client pid={_tunnelProcess.Id}");
    }

    private int RuntimePort => ReadConfiguredPort(section: null, key: "port", fallback: DefaultRuntimePort);

    private int TunnelHealthPort => ReadConfiguredPort(
        section: "tunnel",
        key: "health_port",
        fallback: DefaultTunnelHealthPort
    );

    private int ReadConfiguredPort(string? section, string key, int fallback)
    {
        var value = ReadConfiguredValue(section, key);
        return int.TryParse(value, out var port) && port is >= 1 and <= 65535 ? port : fallback;
    }

    private string ReadConfiguredString(string? section, string key, string fallback)
    {
        var value = ReadConfiguredValue(section, key);
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            value = value[1..^1];
        return value.Length == 0 ? fallback : value;
    }

    private string? ReadConfiguredValue(string? section, string key)
    {
        var configPath = Path.Combine(_appSupport, "config", "openchatx.toml");
        if (!File.Exists(configPath)) return null;

        string? currentSection = null;
        foreach (var rawLine in File.ReadLines(configPath))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                currentSection = line[1..^1].Trim();
                continue;
            }
            if (!string.Equals(currentSection, section, StringComparison.Ordinal)) continue;
            if (!line.StartsWith(key, StringComparison.Ordinal)) continue;

            var equals = line.IndexOf('=');
            if (equals < 0) continue;
            return line[(equals + 1)..].Split('#', 2)[0].Trim();
        }

        return null;
    }

    private static void MigrateLegacyRuntimePort(string configPath)
    {
        if (!File.Exists(configPath)) return;
        var lines = File.ReadAllLines(configPath);

        for (var index = 0; index < lines.Length; index++)
        {
            var raw = lines[index];
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            if (line.StartsWith('[')) break;
            if (!line.StartsWith("port", StringComparison.Ordinal)) continue;

            var equals = raw.IndexOf('=');
            if (equals < 0) break;
            var valueStart = equals + 1;
            while (valueStart < raw.Length && char.IsWhiteSpace(raw[valueStart])) valueStart++;
            var valueEnd = valueStart;
            while (valueEnd < raw.Length && char.IsDigit(raw[valueEnd])) valueEnd++;
            if (!int.TryParse(raw[valueStart..valueEnd], out var port) || port != 3333) break;

            lines[index] = raw[..valueStart] + DefaultRuntimePort + raw[valueEnd..];
            File.WriteAllLines(configPath, lines);
            return;
        }
    }

    private void MigrateLegacyTunnelProfile()
    {
        var profile = TunnelProfile;
        if (profile.Length == 0 || Path.GetFileName(profile) != profile) return;
        var destination = Path.Combine(_profileDirectory, $"{profile}.yaml");
        if (File.Exists(destination)) return;

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var candidates = new[]
        {
            Path.Combine(userProfile, ".config", "tunnel-client", $"{profile}.yaml"),
            Path.Combine(roaming, "tunnel-client", $"{profile}.yaml")
        };
        foreach (var source in candidates)
        {
            if (!File.Exists(source)) continue;
            File.Copy(source, destination, overwrite: false);
            AppendDesktopLog($"Migrated tunnel profile {profile} into OpenChatX app data.");
            return;
        }
    }

    private void MigrateEnvironmentTunnelCredential()
    {
        MigrateEnvironmentCredential("CONTROL_PLANE_API_KEY", "OpenChatX/CONTROL_PLANE_API_KEY");
        MigrateEnvironmentCredential("OPENAI_API_KEY", "OpenChatX/OPENAI_API_KEY");
    }

    private void MigrateEnvironmentCredential(string environmentName, string credentialTarget)
    {
        if (!string.IsNullOrWhiteSpace(WindowsCredentialStore.Load(credentialTarget))) return;
        var value = Environment.GetEnvironmentVariable(environmentName)?.Trim();
        if (string.IsNullOrWhiteSpace(value)) return;
        WindowsCredentialStore.Save(credentialTarget, value);
        AppendDesktopLog($"Migrated {environmentName} into Windows Credential Manager.");
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
            if (args.Data is not null) AppendLogLine(logPath, args.Data);
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is not null) AppendLogLine(logPath, args.Data);
        };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private async Task<bool> HasTunnelProfileAsync()
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
            using var cancellation = new CancellationTokenSource(TunnelProfileProbeTimeout);
            var outputTask = process.StandardOutput.ReadToEndAsync(cancellation.Token);
            var errorTask = process.StandardError.ReadToEndAsync(cancellation.Token);
            try
            {
                await process.WaitForExitAsync(cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                try
                {
                    await Task.WhenAll(outputTask, errorTask);
                }
                catch
                {
                    // Cancellation closes the redirected streams; the timeout is the useful result.
                }
                AppendDesktopLog("Tunnel profile probe timed out after 3 seconds.");
                return false;
            }
            var output = await outputTask;
            _ = await errorTask;
            return process.ExitCode == 0 &&
                   output.Split('\n').Any(line => line.Split('\t').FirstOrDefault()?.Trim() == TunnelProfile);
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

    private async Task<bool> IsTunnelRunningAsync()
    {
        try
        {
            using var response = await _http.GetAsync(TunnelHealth);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            var root = document.RootElement;
            return root.TryGetProperty("live", out var live) && live.ValueKind == JsonValueKind.True;
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> IsTunnelHealthyAsync()
    {
        try
        {
            using var response = await _http.GetAsync(TunnelHealth);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var document = await JsonDocument.ParseAsync(stream);
            var root = document.RootElement;
            if (!root.TryGetProperty("live", out var live) || live.ValueKind != JsonValueKind.True)
                return false;
            if (!root.TryGetProperty("components", out var components) ||
                !components.TryGetProperty("control-plane", out var controlPlane) ||
                !controlPlane.TryGetProperty("status", out var status))
                return false;
            return status.GetString() == "ok";
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

    private Dictionary<string, string?> RuntimeEnvironment(
        string? apiKey = null,
        bool includeTunnelKey = false
    )
    {
        var environment = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
            environment[(string)entry.Key] = entry.Value?.ToString();

        var bundledBin = Path.Combine(_runtimeRoot, "bin");
        var inherited = environment.GetValueOrDefault("Path") ?? "";
        environment["Path"] = bundledBin + Path.PathSeparator + inherited;
        environment["OPENCHATX_DESKTOP"] = "1";

        if (includeTunnelKey)
        {
            var controlPlaneKey = string.IsNullOrWhiteSpace(apiKey)
                ? WindowsCredentialStore.Load("OpenChatX/CONTROL_PLANE_API_KEY")
                : apiKey;
            if (!string.IsNullOrWhiteSpace(controlPlaneKey))
                environment["CONTROL_PLANE_API_KEY"] = controlPlaneKey;
            else
                environment.Remove("CONTROL_PLANE_API_KEY");
        }
        else
        {
            environment.Remove("CONTROL_PLANE_API_KEY");
        }

        var openAiKey = WindowsCredentialStore.Load("OpenChatX/OPENAI_API_KEY");
        if (!string.IsNullOrWhiteSpace(openAiKey))
            environment["OPENAI_API_KEY"] = openAiKey;
        else if (string.IsNullOrWhiteSpace(environment.GetValueOrDefault("OPENAI_API_KEY")))
            environment.Remove("OPENAI_API_KEY");

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
        AppendLogLine(
            Path.Combine(LogsDirectory, "desktop.log"),
            $"[{DateTimeOffset.UtcNow:O}] {message}"
        );
    }

    private void AppendLogLine(string logPath, string line)
    {
        try
        {
            lock (_logWriteGate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                using var stream = new FileStream(
                    logPath,
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete
                );
                using var writer = new StreamWriter(stream, new UTF8Encoding(false));
                writer.WriteLine(line);
            }
        }
        catch (IOException)
        {
            // Logging must never terminate the desktop host when another process briefly owns the file.
        }
        catch (UnauthorizedAccessException)
        {
            // Keep the runtime alive even when diagnostics cannot be written.
        }
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

    private static void SyncDefaultToolboxes(string sourceRoot, string destinationRoot)
    {
        Directory.CreateDirectory(destinationRoot);
        foreach (var sourceToolbox in Directory.EnumerateDirectories(sourceRoot))
        {
            var destinationToolbox = Path.Combine(destinationRoot, Path.GetFileName(sourceToolbox));
            if (!Directory.Exists(destinationToolbox))
            {
                CopyDirectory(sourceToolbox, destinationToolbox);
                continue;
            }

            SyncBuiltinToolboxManifest(sourceToolbox, destinationToolbox);

            var sourceSkills = Path.Combine(sourceToolbox, "skills");
            if (!Directory.Exists(sourceSkills)) continue;
            var destinationSkills = Path.Combine(destinationToolbox, "skills");
            Directory.CreateDirectory(destinationSkills);
            foreach (var sourceSkill in Directory.EnumerateDirectories(sourceSkills))
            {
                var destinationSkill = Path.Combine(destinationSkills, Path.GetFileName(sourceSkill));
                if (!Directory.Exists(destinationSkill))
                    CopyDirectory(sourceSkill, destinationSkill);
            }
        }
    }

    private static void SyncBuiltinToolboxManifest(string sourceToolbox, string destinationToolbox)
    {
        var sourcePath = Path.Combine(sourceToolbox, "toolbox.json");
        var destinationPath = Path.Combine(destinationToolbox, "toolbox.json");
        if (!File.Exists(sourcePath) || !File.Exists(destinationPath)) return;

        var source = JsonNode.Parse(File.ReadAllText(sourcePath))?.AsObject();
        var destination = JsonNode.Parse(File.ReadAllText(destinationPath))?.AsObject();
        if (source is null || destination is null || source["builtin"] is null) return;

        if (destination["enabled"] is JsonNode enabled)
            source["enabled"] = enabled.DeepClone();

        if (source["tools"] is JsonObject sourceTools &&
            destination["tools"] is JsonObject destinationTools)
        {
            foreach (var entry in sourceTools.ToList())
            {
                if (entry.Value is not JsonObject sourceTool ||
                    destinationTools[entry.Key] is not JsonObject destinationTool ||
                    destinationTool["enabled"] is not JsonNode toolEnabled)
                    continue;
                sourceTool["enabled"] = toolEnabled.DeepClone();
            }
        }

        File.WriteAllText(
            destinationPath,
            source.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine
        );
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
