---
name: yummi-order
description: Fill the family's יאמי (yummi.co.il, home cooks) cart from the meals the family chose in the bot, stop at the payment page, and report back. Used by the shopper on the home machine (shopper/main.mjs) for every יאמי order; also read it before changing, running or debugging the יאמי flow (the weekly suggestion, the menu reader shopper/yummi.mjs).
---

# Fill the יאמי cart

You drive a real Chromium browser on the family's home machine, logged in to the family's יאמי account
(www.yummi.co.il, home cooks who deliver cooked meals). You get the meals the family chose from one cook: deals and
dishes, with their choices. Put every one in the cart, go on to checkout, and stop at the payment page. The family pays themselves.

Each tool returns the page: numbered interactive elements `[i]` and the visible text. Act only on numbers from
the latest page. Elements marked `(below)` are further down; you can still click them. Checkboxes and radios show
their label, and "(checked)" when chosen.

## Rules
- Never pay and never place the order. Do not type card, ID or payment details, and do not enter coupon/voucher codes
  (the family does that at payment). Final buttons are blocked anyway; on the payment page call `finish` with `reached_checkout: true`.
- Stay on yummi.co.il. Do not press "סמן אהבתי" / "סמן לא אהבתי", ratings, "הרכבת הזמנה עם AI", the newsletter or the chat box.
- A login form, an SMS code or a "verify you are human" check: call `need_human` with one short Hebrew sentence
  (for example "צריך להתחבר לחשבון יאמי בדפדפן של הבוט"). Never solve these yourself. After it returns, look at the page again.
- First look at the cart ("עגלת קניות" in the header). An order can be a retry: a meal from this list that is already
  in the cart counts as added (call `item_result`), do not add it again. Leave other things in the cart and say so in `finish.note`.

## The site (read from the live site; correct it after real runs)
- הזמנות שלי (/orders): one row per past order (cook, number, date, total). "לפירוט המלא ולהזמנה חוזרת" opens its
  details (address "לאן", time "למתי", the dishes); there "להזמנה חוזרת" puts the same order in the cart again.
- A cook's page (/c/<cook>): the top bar "משלוח" / a city / "למתי?" is the delivery place and time; "מינימום למשלוח N ₪"
  is that cook's minimum. Categories (מבצעים!, עיקריות, ...) hold the cards.
- A deal card ("דיל ...", "מארז ..."): "לבחירת המנות" opens a drawer at the bottom with the deal and "להוספה להזמנה";
  a deal has groups "<group> - סוג אחד לבחירה" (or "2 סוגים לבחירה"): choose exactly what the item's note says, one per
  group, and only then add. A size ("ניתן להגדיל ל-...", "דיל למשפחה עם תוספת ...") is chosen only when the note asks for it.
- A dish card: its variants are radios ("מנה בחרדל דיז'ון", "מנה \"על האש\""...); "הוספת כמות" / "הפחתת כמות" set the qty
  (some dishes start at a minimum, e.g. "מינימום 2"); "להוספה להזמנה ₪X" adds it. "עוד על המנה>>" opens its details.
- A request for the cook ("בלי בצל", "ללא גלוטן", a seasoning the card says to write "בהערות לבשלן") goes in the note
  field of the dish if there is one, otherwise in the order notes at checkout.
- The cart: "עגלת קניות" opens "הסל שלי" (lines, סכום ביניים, משלוח, סה"כ, and the button that goes on to the order).
- Close a drawer or popup with "X" / "סגור" / "סגירה". Popups show at the top of the page under OPEN POPUP.

## For each item
1. Find it on the cook's page (the order starts there; the cook's URL is in the order). Item text = the deal or dish name
   as the menu shows it; `note` = its choices, variant, size or request; `qty` = how many.
2. Set the variant / the deal choices / the qty as asked, then press "להוספה להזמנה".
   If the dish or a choice is not on the menu any more (sold out, not offered on that day), pick nothing in its place: give up on it.
3. Call `item_result` right away: `added` with the name as the site shows it, the qty, and the choices in `product`
   (for example "דיל המנות הפופולריות: פרגית בדיז'ון, קציצות פרסה, לביבות, בולונז"), or `missing` with a short Hebrew reason.

## Finish
Open the cart, check it holds what you added, and go on to the order (the cart's continue button). At checkout:
- Address: the order's delivery address (the family's saved address). If the site shows another city or address,
  choose the family's one; never type a new address.
- Time: the order's delivery time. If it is not offered, take the nearest slot and say which in `finish.note`.
  No time given: the earliest slot.
- Below the cook's minimum the site will not go on: do not add meals the family did not choose. Call `finish` with
  `reached_checkout: false`, `below_minimum` (how much is missing, e.g. "₪45") and the total.
- On the payment page (card details, the final order button) call `finish` with `reached_checkout: true`, the total as shown
  (for example "₪347") and in `note` the delivery time you chose. If you cannot get there, `reached_checkout: false` and a Hebrew `note`.

## Maintenance
(Not sent to the shopper. For Claude Code sessions working on this flow.)
- Flow: once a week (YUMMI_WEEKLY in family-bot/wrangler.toml, e.g. "sun 10:00") the Worker queues a job of kind
  `scan` in kv `order:job` (family-bot/src/yummi.mjs). The shopper reads הזמנות שלי and the last cook's menu in code
  (shopper/yummi.mjs, no Claude) and reports `scanned`; the Worker keeps it in kv `yummi:scan` and sends the suggestion
  with buttons (same again / choose meals / not this week). The family talks with the bot (tool `meals_menu`), then
  `order_start` with store `yummi` queues the chosen meals; `shopper/agent.mjs` fills the cart with this skill.
- The rest (services, the remote view, logs) is the same as in `.claude/skills/carrefour-order`.
- Read the account without Telegram: `node shopper/try.mjs --scan`. One order by hand:
  `STORE=yummi COOK_URL=https://www.yummi.co.il/c/... node shopper/try.mjs "דיל המנות הפופולריות|פרגית בדיז'ון, קציצות פרסה"`.
- Site notes learned from real runs go in the sections above, so the next order is faster.
