# Design and animation skills

Agent skills (SKILL.md) used for this project's UI and motion design. Claude
Code loads them automatically from this folder. Each keeps its upstream
licence file.

| Skill | What it covers | Source | Licence |
|---|---|---|---|
| `frontend-design` | Design process: subject-led direction, tokens, type, restraint, self-critique | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 |
| `ui-ux-pro-max` | Searchable UX rules (accessibility, touch, layout, type, colour, animation, forms) and design-system generator | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT |
| `web-motion-design` | Disney's 12 principles for browser motion; easing and timing | [dylantarre/animation-principles](https://github.com/dylantarre/animation-principles) | MIT |
| `micro-interactions` | Buttons, toggles, badges, validation feedback | same | MIT |
| `css-native` | The principles in pure CSS | same | MIT |
| `feedback-indicators` | Success / error confirmation timing | same | MIT |
| `modals-dialogs` | Dialog entrance, exit and staging | same | MIT |
| `notifications-toasts` | Toast entrance, exit and auto-dismiss | same | MIT |

The ui-ux-pro-max search tool is plain Python 3 with no dependencies, run from
the repository root:

    python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux
