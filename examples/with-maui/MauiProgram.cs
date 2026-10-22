using Microsoft.Maui.Handlers;

namespace WithMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        // The field draws its own border (MainPage.xaml), so drop the platform's underline and rounded frame.
        EntryHandler.Mapper.AppendToMapping("Borderless", (handler, _) =>
        {
#if ANDROID
            handler.PlatformView.Background = null;
#elif IOS
            handler.PlatformView.BorderStyle = UIKit.UITextBorderStyle.None;
#endif
        });

        return MauiApp.CreateBuilder()
            .UseMauiApp<App>()
            // The brand fonts (SIL OFL, see Resources/Fonts/OFL.txt).
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("StackSansNotch_400Regular.ttf", "StackSansNotch");
                fonts.AddFont("Inter_400Regular.ttf", "Inter");
                fonts.AddFont("DMMono_400Regular.ttf", "DMMono");
            })
            .Build();
    }
}
