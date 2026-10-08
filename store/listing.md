# Chrome Web Store listing

Copy for each field of the Chrome Web Store developer dashboard. Images are in this folder.

## Store listing tab

**Name** (from the manifest)
Just Filed: AI bookmark folders

**Summary** (132 characters max; this is 120)
File any bookmark in seconds. Type to find a folder or make a new one, with AI suggestions that never leave your browser.

**Category**
Productivity (Workflow & planning)

**Language**
English (Australia)

**Description**

Chrome makes you scroll a dropdown to find a bookmark folder. Just Filed gives you a search box instead.

FIND THE FOLDER. OR MAKE ONE.
• Open Just Filed on any page and type a few letters. Every folder that matches appears instantly.
• Type a name that does not exist and create the folder on the spot. Type "Parent / Name" to put it somewhere specific.
• Press Enter. It is filed, and there is an undo.

SUGGESTIONS THAT GET IT RIGHT
• The closest folders are listed before you type, based on where you have been saving lately, where the same website already lives, and what the page is about.
• An AI model reads page titles and folder names for meaning, so a page called "stablecoin bank" finds your "Finance" folder even though no word matches.
• Bookmark with the star as usual, and if the page clearly belongs somewhere else, Just Filed opens and says so. You choose how often it speaks up.

TIDY UP WHAT IS ALREADY THERE
• Just Filed checks your library for bookmarks that look out of place, and loose ones that have a likely home.
• Review them one at a time: move, keep or skip. Bookmarks you keep are never suggested again.

PRIVATE BY DESIGN
• The AI model is bundled with the extension and runs on your computer.
• No account, no server, no analytics. Just Filed makes no network requests at all.
• Open source, so anyone can check: https://github.com/Justusability/just-filed

Made by Justusability, who find where customers get stuck and fix it. https://www.justusability.com

**Screenshots** (1280×800, in this order)
1. `screenshot-1-find.png`: Type to find any folder, or make a new one.
2. `screenshot-2-suggest.png`: It notices when a bookmark lands in the wrong place.
3. `screenshot-3-tidy.png`: Tidy up bookmarks that look out of place.
4. `screenshot-4-private.png`: The AI runs on your computer.

**Small promo tile** (440×280)
`promo-small.png`

**Official URL / Homepage**
https://www.justusability.com

**Support URL**
https://github.com/Justusability/just-filed/issues

## Privacy practices tab

**Single purpose**
Just Filed helps people file their Chrome bookmarks into the right folder: it lets them search for and create folders when saving a bookmark, suggests the best folder, and helps them move bookmarks that are in the wrong place.

**Permission justifications**

| Permission | Justification |
|---|---|
| `bookmarks` | Core purpose. Reads bookmark titles, addresses and folders to suggest where a bookmark belongs and to let the user search for folders, and moves or creates bookmarks and folders when the user chooses one. |
| `storage` | Saves the user's settings and what the extension has learned about where they file each website, on the device only. |
| `activeTab` | When the user opens Just Filed, reads the title and address of the current tab so it can be bookmarked straight into the chosen folder. No access at any other time and no access to page content. |
| `offscreen` | Hosts the bundled on-device AI model in a hidden extension page so it stays loaded between saves and answers in milliseconds. The model runs locally; nothing is sent over the network. |

**Remote code**
No, I am not using remote code. (All code, including the WebAssembly model runtime and the model file, is packaged with the extension.)

**Data usage**
Google requires disclosure even when data is only processed on the device ("handle" covers collecting, using or sharing, local or not). So declare it rather than answering "none":

- Tick **Web history**: Just Filed reads bookmark titles and addresses, and the current tab's title and address when the user opens it.
- Leave every other category unticked. It reads no page content, personal details, location, messages or credentials.
- Explain, if there is a free-text box: "Bookmark and tab titles and addresses are processed on the user's device to suggest folders. Nothing is transmitted off the device, stored on a server, or shared with anyone."

Then tick the three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
https://github.com/Justusability/just-filed/blob/main/PRIVACY.md
(Replace with a page on justusability.com if you publish one there.)
