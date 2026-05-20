# Interactive Pool Audio Assets

Drop sound files into this directory to enable audio feedback. All files are
optional -- the app degrades gracefully when a file is missing.

| Filename             | Played by | Trigger                          |
| -------------------- | --------- | -------------------------------- |
| `opening_menu.mp3`   | menu      | gesture opens the menu           |
| `closing_menu.mp3`   | menu      | gesture or auto-timeout closes   |
| `click.mp3`          | menu      | navigation / app-launch button   |

Other formats (`.wav`, `.ogg`) work too, but make sure the file name matches
exactly what the code requests (see `src/layers/menu.ts`).
