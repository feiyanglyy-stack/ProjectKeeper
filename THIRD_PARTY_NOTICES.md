# Third-party notices

ProjectKeeper's own code is under the MIT licence (see [LICENSE](LICENSE)). This file lists the third-party material
that is redistributed inside this repository. Packages that npm installs (`package.json`, `package-lock.json`) are not
redistributed here; each carries its own licence in `node_modules`.

## pi-ai (`@earendil-works/pi-ai`), versions 0.87.1 and 0.85.0 — MIT

Where: `patches/pi-ai-0.87.1.ts` and `patches/pi-ai-0.85.0.ts`.

These two files describe the changes ProjectKeeper makes to the installed copy of pi-ai (`patches/README.md` says what
the changes do). To find the places to change, each file quotes short passages of pi-ai's distributed JavaScript
(`dist/utils/json-parse.js`, `dist/utils/validation.js` and six files under `dist/api/`) next to the text that replaces
them. Those quoted passages are pi-ai's, used under its licence:

- Package: `@earendil-works/pi-ai`, from <https://github.com/earendil-works/pi> (`packages/ai`)
- Licence: MIT

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The themes under `ui/themes/` — not open source

The four themes (`a1`, `b1`, `d2`, `i1`) were made for another product, WorkflowKeeper, by the same author, and are
shipped with ProjectKeeper as they are. They are not covered by the MIT licence: see
[ui/themes/LICENSE.md](ui/themes/LICENSE.md).

## Colour-vision simulation matrices

`scripts/palette-check.py` (a development check, not part of the running product) uses the protanopia and deuteranopia
simulation matrices published in Machado, Oliveira and Fernandes, "A Physiologically-based Model for Simulation of Color
Vision Deficiency", IEEE Transactions on Visualization and Computer Graphics, 2009.
