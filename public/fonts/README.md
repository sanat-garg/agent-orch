# Bundled fonts

- Inter 4.1: https://github.com/rsms/inter/releases/tag/v4.1 — original variable WOFF2 normal and italic, weights 100–900; license in Inter-OFL.txt.
- JetBrains Mono 2.304: https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304 — variable normal and italic, weights 100–800; license in JetBrainsMono-OFL.txt. The release contains static WOFF2 only, so these WOFF2 files are lossless FontTools conversions of `fonts/variable/JetBrainsMono[wght].ttf` and `JetBrainsMono-Italic[wght].ttf` (`TTFont`, set `flavor = 'woff2'`, save).

Font URLs include the release version because the server caches them immutably. Update filenames and references when upgrading. Server screenshot fonts use the same release TTFs (Inter variable plus static faces for the OS family name `Inter`, and JetBrains Mono variable) in `~/.local/share/fonts/` (`fc-cache -f`).
