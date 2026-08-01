# Sprites — swap these for whatever you like

Every file here is a **placeholder** I drew. They exist so the feature works out of the
box; they are meant to be replaced.

**This directory is live.** In the running container it is
`<your edit dir>/server/public/sprites/` — drop a file in and reload the browser. No
rebuild, no restart. (See "Editing it while it runs" in the top-level README.)

## What gets used where

**Every file here is in one pool, and every icon draws from it.** There are no special
filenames — a pane's icon and each of the two scrubber handles are a pick from everything
in this directory. Add a file and it joins the pool; the names are yours to choose and
nothing reads them.

| icon slot | what it draws |
| --- | --- |
| a pane's header icon | one file at random, rolled when the pane opens |
| the scrubber's **start** handle | one file at random, rolled when the page loads |
| the scrubber's **end** handle | the same, re-rolled off the start handle if it lands on the same file |

The picks are **random, not stable**. Nothing is keyed on anything: reload the page and
every icon in the dashboard is something else, and the same container on two hosts draws
two different creatures. So an icon here identifies nothing — the container's name is
written beside it everywhere one appears, and that's the part that identifies the pane.

This was hashed on the container's name once, and the reason it isn't any more is worth
knowing if you're thinking of putting it back: an icon that holds still starts to look like
it's *reporting* something, and you spend a moment each time working out what. One that has
visibly just changed for no reason is one you stop reading meaning into. What you give up is
being able to say "this one is always the database".

`<ext>` is `svg`, `png`, `webp`, `gif`, `jpg` or `jpeg`; anything else in here is ignored
(this README included). The `_1`…`_6` and `_slider-a`/`_slider-b` names are leftovers from
when those slots were reserved — they're ordinary pool members now, and worth renaming to
whatever the drawings actually are.

## Notes

- **Square images.** These are drawn into square boxes (44px in a pane header, 40px on a
  slider handle), so anything else gets letterboxed rather than stretched.
- **SVG scales, bitmaps don't.** A 16×16 PNG on a high-DPI screen will look soft. If
  you're using bitmaps, 64×64 or larger is worth it.
- Icons only appear in **pokédex mode**. Yeet mode is deliberately monochrome and shows
  the plain state marks instead.
- Nothing here is fetched from the network — the app only ever reads this directory.

## A word on what you put here

Whatever you drop in is served by your own instance to whoever can reach it. Pokémon
sprites are Nintendo's, and that's true regardless of whether a project makes money, so
it's worth knowing that a public deployment is a different thing from your own laptop.
Your call, your box — this note is just so it isn't a surprise.
