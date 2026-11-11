namespace WithMaui;

public partial class MainPage : ContentPage
{
    static readonly Color Green = Color.FromArgb("#64FF9D");
    static readonly Color Mint = Color.FromArgb("#8AF9FF");
    static readonly Color Neutral800 = Color.FromArgb("#1C1C1C");

    public MainPage() => InitializeComponent();

    void OnNameFocusChanged(object? sender, FocusEventArgs e) => UpdateOutline();

    /// Focus and the error change the field's outline colour only, so nothing moves.
    void UpdateOutline() =>
        NameField.Stroke = ErrorLabel.IsVisible ? Mint : NameEntry.IsFocused ? Green : Neutral800;

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
            GreetingLabel.Text = $"hello, {value}!";
            GreetingPanel.IsVisible = true;
            NameEntry.Text = string.Empty;
        }

        // Unfocus alone leaves the Android keyboard open over the result.
        await NameEntry.HideSoftInputAsync(CancellationToken.None);
        NameEntry.Unfocus();
        UpdateOutline();
    }
}
