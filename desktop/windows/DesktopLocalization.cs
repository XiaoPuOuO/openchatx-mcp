using System.Globalization;

namespace OpenChatX.Desktop;

/// <summary>
/// Native Windows strings. The React dashboard owns the user-selected locale and
/// notifies WebView2 whenever the selection changes.
/// </summary>
internal static class DesktopLocalization
{
    private static string _locale =
        CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "vi" ? "vi" : "en";

    public static bool SetLocale(string? value)
    {
        if (value is not ("en" or "vi" or "zh-TW" or "ja" or "ru")) return false;
        _locale = value;
        return true;
    }

    public static string T(string english)
    {
        if (_locale != "vi") return english;
        return english switch
        {
            "More" => "Thêm",
            "Start Runtime" => "Khởi động Runtime",
            "Stop Runtime" => "Dừng Runtime",
            "Open OpenChatX" => "Mở OpenChatX",
            "Pause Agent Access" => "Tạm dừng quyền truy cập của Agent",
            "Resume Agent Access" => "Tiếp tục quyền truy cập của Agent",
            "Quit OpenChatX" => "Thoát OpenChatX",
            "Restart Runtime" => "Khởi động lại Runtime",
            "Tunnel Connected" => "Đã kết nối Tunnel",
            "Connect Tunnel…" => "Kết nối Tunnel…",
            "Open Logs" => "Mở nhật ký",
            "Starting local capability runtime…" => "Đang khởi động Runtime cục bộ…",
            "OpenChatX could not start." => "Không thể khởi động OpenChatX.",
            "OpenChatX's embedded browser did not initialize within 15 seconds." =>
                "Trình duyệt tích hợp của OpenChatX không khởi tạo được trong 15 giây.",
            "OpenChatX could not initialize its embedded browser." =>
                "OpenChatX không thể khởi tạo trình duyệt tích hợp.",
            "The local OpenChatX runtime will continue independently of the browser." =>
                "Runtime OpenChatX cục bộ vẫn tiếp tục hoạt động độc lập với trình duyệt.",
            "Restart once with a fresh isolated application-data directory? Existing data will not be deleted." =>
                "Khởi động lại một lần với thư mục dữ liệu ứng dụng mới, tách biệt? Dữ liệu hiện có sẽ không bị xóa.",
            "If the isolated restart also fails, install or repair Microsoft Edge WebView2 Runtime." =>
                "Nếu vẫn không khởi động được, hãy cài đặt hoặc sửa chữa Microsoft Edge WebView2 Runtime.",
            "OpenChatX browser recovery" => "Khôi phục trình duyệt OpenChatX",
            "Could not start the isolated recovery instance." =>
                "Không thể khởi động phiên khôi phục tách biệt.",
            "OpenChatX Tunnel disconnected" => "Tunnel OpenChatX đã ngắt kết nối",
            "The Secure MCP Tunnel lost its control-plane connection." =>
                "Secure MCP Tunnel đã mất kết nối đến hệ thống điều khiển.",
            "Tunnel setup failed" => "Thiết lập Tunnel thất bại",
            "Connect OpenAI Secure MCP Tunnel" => "Kết nối OpenAI Secure MCP Tunnel",
            "Enter the control-plane API key. It is stored in Windows Credential Manager." =>
                "Nhập khóa API điều khiển. Khóa được lưu trong Windows Credential Manager.",
            "Enter the Tunnel ID and control-plane API key. The API key is stored in Windows Credential Manager." =>
                "Nhập mã Tunnel và khóa API điều khiển. Khóa API được lưu trong Windows Credential Manager.",
            "Tunnel ID" => "Mã Tunnel",
            "Control-plane API key" => "Khóa API điều khiển",
            "API key" => "Khóa API",
            "Connect" => "Kết nối",
            "Cancel" => "Hủy",
            _ => english
        };
    }
}
