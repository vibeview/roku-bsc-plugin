# vibeview-bsc-plugin

A [BrighterScript](https://github.com/rokucommunity/brighterscript) plugin that lets
VibeView see which item your Roku channel highlights, and gives items stable test ids.
Recorded tests then replay by element ("select The Beekeeper") instead of by key presses,
so they keep working when a rail changes order.

Requires `brighterscript` 0.73.

## Setup

```bash
npm install --save-dev brighterscript@0.73 vibeview-bsc-plugin
npx vibeview-bsc-plugin init
```

`init` adds the plugin to `bsconfig.json` with markers off. Build your test builds with
markers on, and your store builds as usual:

```bash
VIBEVIEW_MARKERS=1 npx bsc   # test build for VibeView
npx bsc                      # store build: nothing is marked
```

Items in Roku's own lists (`RowList`, `MarkupGrid`, `MarkupList`, `ZoomRowList`) work
with no further setup: the plugin reads the item's `itemHasFocus`, `itemContent.id` and
`itemContent.title`.

## Your own components

If your components track their highlight in a boolean field, list it. Also list the
fields that hold a stable id and a readable name:

```json
"vibeview": {
  "enabled": false,
  "highlightFields": ["isFocused", "itemHasFocus"],
  "idFields": ["itemContent.id", "id"],
  "labelFields": ["itemContent.title"]
}
```

- Fields are tried in order; the first one a component has wins. A path is a field of the
  component (`id`) or a field of a node it holds (`itemContent.title`).
- A list you write replaces the default, so keep `itemHasFocus`, `itemContent.id` and
  `itemContent.title` in it if you use Roku's lists. The build warns when one is missing.
- `"components": { "SearchBar": false }` leaves a component out, for example when its
  `isFocused` means something else. `"components": { "PromoTile": "selected" }` picks
  the field for one component.

## Marking by hand

When the highlight isn't a boolean field (an index, or a parent that restyles a child),
the easiest fix is usually to add one:

```brightscript
' GridCard keeps its highlight in an integer focusPart
m.top.isFocused = (m.top.focusPart = 0)
```

Or call the helpers from your code. They are available in any component that calls them:

```brightscript
vibeview_setHighlight(oldItem, false)   ' clear the previous item yourself
vibeview_setHighlight(newItem, true)
vibeview_setId(poster, "row1.poster")   ' a test id for a node created in code
```

For a node declared in XML, add a `vibeviewId` (the element also needs an `id`):

```xml
<Poster id="icon" vibeviewId="nav-icon" />
```

## Good to know

- **Store builds** get no markers. Components that call the helpers get versions that
  do nothing.
- **Pick ids that name one thing** and stay the same across brands and languages: a
  content id or a node `id`, not a shared style or theme id.
- **Poster-only tiles** have no visible title. Add a content field for one (for example
  `vibeviewLabel`) and list it in `labelFields`.
- Test ids may use `A-Z a-z 0-9 _ . -`.
- Function names starting with `vibeview_` are reserved.
- The marker is added as a component's last child. The build warns if a component's
  scripts index its children (`getChild`), and skips components with inline `<script>`
  code; move that code into a `.brs` file.

## Config

| Key               | Default                 | Meaning                                                  |
| ----------------- | ----------------------- | -------------------------------------------------------- |
| `enabled`         | `false`                 | Add markers. `VIBEVIEW_MARKERS=1` also turns them on.    |
| `highlightFields` | `["itemHasFocus"]`      | Boolean fields that mean "this item is highlighted".     |
| `idFields`        | `["itemContent.id"]`    | Where to read a stable test id.                          |
| `labelFields`     | `["itemContent.title"]` | Where to read a readable name.                           |
| `components`      | `{}`                    | Per component: `false` to skip it, or a field name.      |
