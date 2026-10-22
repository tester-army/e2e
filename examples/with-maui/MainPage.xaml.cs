namespace WithMaui;

public partial class MainPage : ContentPage
{
    public MainPage() => InitializeComponent();

    async void OnGreet(object? sender, EventArgs e)
    {
        var value = NameEntry.Text?.Trim() ?? string.Empty;
        if (value.Length == 0)
        {
            ErrorLabel.IsVisible = true;
            GreetingPanel.IsVisible = false;
            // TalkBack and VoiceOver read the error when it appears.
            SemanticScreenReader.Announce(ErrorLabel.Text);
        }
        else
        {
            ErrorLabel.IsVisible = false;
            GreetingLabel.Text = $"Hello, {value}!";
            GreetingPanel.IsVisible = true;
            NameEntry.Text = string.Empty;
        }

        // Unfocus alone leaves the Android keyboard open over the result.
        await NameEntry.HideSoftInputAsync(CancellationToken.None);
        NameEntry.Unfocus();
    }
}
