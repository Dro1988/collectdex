# CollectDex

Search, value and track your collectible card & comic collection — Pokémon, Magic: The Gathering, Yu-Gi-Oh!, Lorcana, One Piece, sports cards, comics, and My Little Pony CCG.

**Live at https://dro1988.github.io/collectdex/**

## How it works
- **Local-first:** your collection, binders and wishlist are saved in your own browser (localStorage). No account, no sign-up, nothing leaves your device.
- **Live catalogs (free, no keys):** Pokémon via [TCGdex](https://tcgdex.net), Magic via [Scryfall](https://scryfall.com), Yu-Gi-Oh! via [YGOPRODeck](https://ygoprodeck.com) — called directly from your browser.
- **Quick camera scanning:** open the camera (or upload a photo), type the card name, and CollectDex ranks candidate matches from all three live catalogs — you confirm the exact printing before it's added. Nothing is ever auto-added. (Full AI vision ID is structured to plug in behind a vision key; it is not faked in the meantime.)
- **Smart touches:** live autocomplete suggestions while you type, duplicate detection with an in-flow warning, "cards you're missing" per Pokémon set (tap any set), and price snapshots per item — hit **Refresh prices** and the Insights panel shows your biggest movers.
- **Power tools:** filters + sorting (category, binder, value, gain, date), CSV/JSON export and import, wishlist target prices with at/below-target badges and notes, per-item condition, grading company + grade + cert #, location and quantity.
- **Honest prices:** every price is labeled with its source (e.g. "TCGplayer market via TCGdex"). Categories with no legitimate pricing source (My Little Pony, comics, sports cards) show values as unavailable rather than invented numbers.
- **Set progress:** Pokémon set completion from the live TCGdex set list (all sets, filterable); all 12 Enterplay My Little Pony CCG sets tracked by hand.

Plain static HTML/CSS/JS — no build step, no server.
