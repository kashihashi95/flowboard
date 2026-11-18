# Flowboard Markdown

Flowboard can open any `.md` file written in this format (menu → **Open file**, or drag the file onto the board), and **Export → Markdown** writes the same format. You can write a whole flowchart by hand, or ask an AI assistant to write one, without ever giving a position: Flowboard lays it out for you.

## The shortest possible file

```markdown
## Connections

- Start --> Fill in form
- Fill in form --> Valid?
- Valid? --> Save : Yes
- Valid? --> Fill in form : No
```

Naming a step in a connection creates it: a Decision diamond if its text ends with `?`, otherwise a Process box. To choose shapes, colors and so on, list the shapes first (below).

## Overall layout of a file

```markdown
---
title: Password reset
layout: down
---

# Password reset

Plain paragraphs like this one are notes for people; Flowboard ignores them.

- [terminal] Start {#start color=green}
- [process] Enter email {#email}

## Section: Checks {color=blue}

- [decision] Account exists? {#exists}

## Connections

- start --> email
- email --> exists
```

| Part | What it does |
|---|---|
| Front matter (between `---` lines, optional) | `title:` names the board. `layout: down` (default) or `layout: right` sets the direction of the automatic layout. |
| `# Heading` (level 1) | Used as the board name if there's no `title:`. |
| List items `- …` | Each one is a shape. |
| `## Section: Name` | Starts a section. The shapes listed under it go inside it. |
| `## Connections` | Every list item under this heading is a connector. |
| Any other heading | Ends the current section (for example `## Notes`). |
| Code blocks and `<!-- comments -->` | Ignored. Exports put a Mermaid preview here for Obsidian. |

## Shapes

One list item per shape:

```
- [kind] Text of the shape {attributes}
```

The `[kind]` is optional; without it you get a Process box.

| Kind | Also accepted | Shape |
|---|---|---|
| `process` | `rect`, `rectangle`, `box` | Rectangle |
| `terminal` | `rounded`, `pill`, `start`, `end` | Rounded pill |
| `decision` | `diamond` | Diamond |
| `ellipse` | `circle`, `oval` | Ellipse |
| `io` | `input/output`, `parallelogram`, `data` | Parallelogram |
| `database` | `cylinder`, `db` | Cylinder |
| `preparation` | `hexagon` | Hexagon |
| `sticky` | `note` | Sticky note |
| `text` | `label` | Free text, no box |
| `image` | `picture` | Image |

### Several lines of text, and lists

Put extra lines under the item, indented by two spaces. Each line is a new line in the shape. Indented `- ` lines become a bulleted list and `1. ` lines a numbered list.

```
- [sticky] {#tip color=yellow}
  Before launch:
  1. Check the copy
  2. Test on mobile
  - Ask Sam about legal
```

A line with only `<br>` is an empty line. To start a line with a character that would make it a list or heading (`-`, `1.`, `#`, `>`), put a backslash in front: `\- not a bullet`.

### Text formatting

| Write | Result |
|---|---|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `~~strike~~` | ~~strike~~ |
| `<u>underline</u>` | underline |
| `<span style="color:#e03e2d">red text</span>` | colored text (any CSS color) |
| `==phrase==` | a **link point**: highlighted words a connector can attach to |

Use a backslash to write a character literally: `\*`, `\=`, `\{`, `\[`, `\<`, `\\`.

### Shape attributes

Attributes go in curly braces at the end of the item's first line, separated by spaces. All are optional.

| Attribute | Example | Meaning |
|---|---|---|
| `#id` | `{#login}` | A short name used in connections. Without one, connections can use the shape's text. |
| `color=` | `color=blue` | Fill color: `gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `violet`, `pink`, `black` (or `default`). For text shapes, this is the text color. |
| `outline=` | `outline=red`, `outline=none` | Outline color (same names), or no outline. |
| `outline-width=` | `outline-width=3` | Outline thickness. |
| `outline-dashed` | `outline-dashed` | Dashed outline. |
| `font=` | `font=24` | Text size in points (1–1000). |
| `align=` | `align=left` | Text alignment: `left`, `center`, `right`. On an indented line, `{align=right}` sets just that line. |
| `at=` | `at=120,40` | Position of the top-left corner. Leave it out and Flowboard places the shape. |
| `size=` | `size=200x80` | Width × height. Leave it out and the shape widens to fit its text, as it does while you type. |
| `fixed` | `fixed` | The size was set by hand: when the text changes, the shape keeps its width and only grows taller. Exports add it to shapes you resized. |
| `src=` | `src=https://…/logo.png` | Picture for an image (or write `![](url)` as its text). |

Images: `- [image] ![](https://example.com/diagram.png) {size=320x200}`. Exports embed the picture itself as a `data:` URL, so the file is self-contained.

## Sections

```
## Section: Validation {#validation color=blue}

- [decision] Details valid?
- [process] Show errors

### Section: Nested section

- [process] Something inside both
```

Every shape listed under a section heading goes inside that section. Deeper headings (`###`) nest sections. Any heading at the same level or above ends it. Sections take the `#id`, `color=`, `at=` and `size=` attributes. Without a size, a section grows to fit what's in it.

## Connections

Under a `## Connections` heading, one list item per connector:

```
- from --> to : label {attributes}
```

`from` and `to` are a shape's `#id` (with or without the `#`) or its exact text. Naming a shape that doesn't exist creates it (a Decision diamond if the text ends with `?`, otherwise a Process box).

| Arrow | Meaning |
|---|---|
| `-->` | Arrow at the end |
| `<--` | Arrow at the start |
| `<-->` | Arrows at both ends |
| `---` | Plain line, no arrowheads |
| `-.->` `<-.-` `<-.->` `-.-` | The same, dashed |
| `==>` `<==` `<==>` `===` | The same, thick |

Write a label after ` : `. Use `<br>` for a line break inside it.

### Attaching to a side or to highlighted words

| Write | Meaning |
|---|---|
| `login:right` | Attach to the right side of `login` (`top`, `right`, `bottom`, `left`). |
| `login:right@25%` | Attach anywhere on a side: here a quarter of the way down the right side (top and bottom count from the left). Without `@`, the middle. |
| `tip[one hour]` | Attach to the link point `==one hour==` inside `tip`. |
| `tip[one hour]:left` | Link point, leaving from its left end. |
| `tip[one hour #2]` | The second place `==one hour==` is highlighted in `tip`. |
| `(300, 120)` | A loose end at a point on the board. |

### Link points step by step

A link point is a connector that starts or ends at a few highlighted words inside a shape, not at the shape's edge.

1. Highlight the words in the shape with `==…==`.
2. In the connection, put the same words in square brackets right after the shape's id: `shape[words]`.

```
- [sticky] Links expire in ==one hour== and are ==single use== {#tip}
- [process] Send reset link {#send}

## Connections

- tip[one hour] --> send
- send --> tip[single use]
```

The words in brackets are matched ignoring capitals and formatting, and `[==one hour==]` works too. If the words aren't highlighted in the shape but do appear in its text, Flowboard highlights them for you. If they don't appear at all, the connector attaches to the whole shape and Flowboard tells you which line it couldn't match. If the same words are highlighted more than once in one shape, add `#2`, `#3`… for the later ones. Exports always write link points this way, so they come back attached to the same words.

The same link in several shapes is just the same highlighted words in each, joined by connectors. In the app, typing `/` while editing a shape lists the links already on the board; picking one adds it and a dashed connector to every other copy. To keep the board clean, these dashed link connectors (dashed, no arrowheads, same words at both ends) only show while one of their shapes is selected. In Markdown that is:

```
- [sticky] Unlocks: ==Beast Taming== {#tree}
- [process] Pen needs ==Beast Taming== {#pen}

## Connections

- tree[Beast Taming] -.- pen[Beast Taming]
```

### Connector attributes

| Attribute | Example | Meaning |
|---|---|---|
| `color=` | `color=red` | Line color (same names as shapes). |
| `width=` | `width=4` | Line thickness. |
| `dashed` / `solid` | `dashed` | Dashed or solid line, overriding the arrow. |
| `route=` | `route=curved` | `elbow` (default), `straight` or `curved`. |
| `start=`, `end=` | `end=circle` | Arrowhead: `none`, `triangle`, `arrow`, `triangle-open`, `circle`, `circle-open`, `diamond`, `bar`. |
| `label=` | `label="Yes, retry"` | Another way to write the label. |
| `label-at=` | `label-at=30%` | Where along the line the label sits, by length from the start (default 50%, the middle). Tidy up sets this to keep labels clear of shapes. |
| `points=` | `points=300,120;300,240` | A hand-adjusted elbow route: the corner points between the two ends, as `x,y` pairs separated by `;`. Exports write this when you have dragged a connector's segments. |

## Positions and automatic layout

- **No positions anywhere:** Flowboard lays the chart out as a layered flowchart (`layout: down` or `right`). Each section becomes its own block, shapes with no connections go in a column beside the flow, and connectors that loop back go around the side.
- **Positions on everything:** shapes go exactly where you say. Exports always write positions, so a file you export and reopen comes back as it was.
- **A mix:** shapes with `at=` stay put, and the rest are laid out together to their right.

When Flowboard lays a chart out, it also routes the connectors: they leave and enter shapes straight, spread along each side in the order that avoids crossing at the shape, go around shapes, words and section titles instead of through them, and run in separate lanes when several share a gap. Connectors that loop back go around the outside. The routes are written into the file as `points=`, so they come back the same.

Once a board is open, the **Tidy up** button (Shift+T) does the same for a board you have drawn: it keeps your sections together and in their order, keeps shapes in roughly the order you put them, grows boxes whose words spill out, and picks whichever direction (down or right) tangles less.

## A complete example

```markdown
---
title: Password reset
layout: down
---

# Password reset

- [terminal] Start {#start color=green}
- [process] User clicks **Forgot password** {#forgot}
- [io] Enter email {#email}

## Section: Checks {color=blue}

- [database] Look up user {#lookup}
- [decision] Account exists? {#exists color=yellow}

## Section: Outcomes

- [process] Send reset link {#send}
- [process] Show *generic* message {#generic color=red outline=red outline-dashed}
- [terminal] Done {#done color=green}

## Notes

- [sticky] {#tip color=pink}
  Remember:
  - links expire in ==one hour==
  - rate-limit by IP

## Connections

- start --> forgot
- forgot --> email
- email --> lookup
- lookup --> exists
- exists --> send : Yes {color=green}
- exists -.-> generic : No
- send --> done
- generic --> done {route=curved end=circle}
- tip[one hour] --- send
```

## Timeline, view and toggles

Everything on the board itself is in the file: every shape kind, color, outline, font size, text formatting, list, link point, picture, section and connector setting (sides, `@` positions, routes, hand-adjusted corners, arrowheads, labels). Exporting a board and opening the file again gives back the same board.

When Flowboard saves a whole board (Save to workspace, or Export → Markdown of the board), it also adds one hidden block at the very end, starting `<!-- flowboard:history`. It holds the timeline's track points, the zoom and scroll position, and the Diff, Flow and crossing-color toggles, and opening the file brings them back. Markdown viewers don't show it. Each line is one piece of JSON:

- the view and toggles;
- each picture used by a track point, written once (or a pointer to the same picture in the board above);
- one line per track point, holding only what changed since the point before it: shapes and connectors that are new or edited, and the ids of those that are gone.

You never need to write this block by hand. Leave it out of files you write yourself, and delete it from a file to drop its history. Exports of a selection or of what's new leave it out. A Flowboard .html file (Export → HTML) keeps the same things.

## Tips for writing these with an AI assistant

Give the assistant this page and ask for "a Flowboard Markdown file". If the file it's editing ends with a `<!-- flowboard:history` block, the assistant must leave that block exactly as it is and change only the Markdown above it; the block says so itself too. Ask it to leave out `at=` and `size=` so Flowboard does the layout. If a line can't be read, Flowboard opens the rest of the file and tells you which line it skipped.
