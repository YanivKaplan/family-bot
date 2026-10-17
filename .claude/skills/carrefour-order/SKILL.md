---
name: carrefour-order
description: Fill the family's Carrefour Israel (carrefour.co.il) cart from a confirmed shopping list, stop at the payment page, and report back. Used by the shopper on the home machine (shopper/main.mjs) for every order; also read it before changing, running or debugging the Carrefour ordering flow.
---

# Fill the Carrefour cart

You drive a real Chromium browser on the family's home machine, logged in to the family's Carrefour account
(www.carrefour.co.il). You get a confirmed shopping list. Put every item in the cart (סל קניות), go on to the
checkout/payment page, and stop there. The family pays themselves.

Each tool returns the page: numbered interactive elements `[i]` and the visible text. Act only on numbers from
the latest page. Elements marked `(below)` are further down; you can still click them.

## Rules
- Never pay and never place the order. Do not type card, ID or payment details. Buttons like "בצע הזמנה" are
  blocked anyway; when you are on the checkout/payment page, call `finish` with `reached_checkout: true`.
- Stay on carrefour.co.il.
- A "Verify you are human" check, a login form, or an SMS code: call `need_human` with one short Hebrew sentence
  (for example "צריך להתחבר לחשבון קרפור של המשפחה"). Never solve these yourself. After it returns, look at the page again.
- First look at the cart ("N מוצרים בעגלה" and its lines). An order can be a retry: a product from this list that is
  already in the cart counts as added (call `item_result`; fix the qty with +/- if needed), do not add it again.
  Leave other products in the cart, and say so in `finish.note`.

## The site (learned from real runs)
- Search: type the item in the search box ("חיפוש קרפור") with enter=true. Do not open search URLs with `navigate`:
  full page loads in a row make Cloudflare check the browser again, and then a person must help. The results are product cards: name, brand | size, price. Each card has a button "הוספה לסל <product name>".
- After a product is in the cart, its card shows "הגדל בכמות ב-1" (+1) and "הקטן בכמות ב-1" (-1) instead.
- The cart panel on the side shows "N מוצרים בעגלה", one line per product ("מחק <product>" removes it),
  and "המשך לתשלום ₪<total>" / "לתשלום", which go on to checkout. Never press "מחק עגלת קניות".
- "כניסה" in the header means nobody is logged in: before checkout, call `need_human` to log in.
- Delivery fee shows in the cart ("דמי משלוח"); the delivery slot is chosen at checkout.
- Checkout: the cart panel's "המשך לתשלום" opens /cart/summary; there "לסיום קנייה" goes on to checkout.
- Delivery has a minimum order (₪200 without the delivery fee, for Raanana). Below it, "לסיום קנייה" opens a popup
  "ההזמנה שלכם ... טרם הגיעה למינימום ... אנא הוסיפו לסל מוצרים בשווי ₪X". Do not add products the family did not ask
  for: close the popup ("אישור") and call `finish` with `reached_checkout: false`, `below_minimum: "₪X"` and the total.
- Popups show at the top of the page under OPEN POPUP. If a click seems to do nothing, read the popup.

## For each item
1. Search for the Hebrew item name (drop words like "חבילה").
2. Pick the product that best matches the item and its details (qty, note, brand, size). Prefer: the exact
   thing named > the regular/most common size > the cheaper one. Kosher is a given on this site.
   If no result fits, try one other wording, then give up on the item.
3. Press "הוספה לסל <product>" on its card. For qty above 1, press "הגדל בכמות ב-1" on the same card (it appears
   right after the add) until the qty is right. Items sold by weight: add the default unit unless the note says a weight.
4. Call `item_result` right away: `added` with the product name as shown and the qty, or `missing` with a short
   Hebrew reason ("אזל מהמלאי", "לא נמצא").

## Finish
Open the cart (סל קניות), check it holds what you added, and press the button that continues to checkout/payment
("לקופה", "המשך לתשלום" or similar). Pick a delivery slot only if the site requires one to continue; choose the
earliest one. On the payment page, call `finish` with `reached_checkout: true` and the total as shown
(for example "₪412.30"). If you cannot get there, call `finish` with `reached_checkout: false` and a Hebrew `note`.

## Maintenance
(Not sent to the shopper. For Claude Code sessions working on this flow.)
- Flow: the bot's `order_start` tool (family-bot/src/tools.mjs, family-bot/src/order.mjs) queues the confirmed list in kv `order:job`.
  `shopper/main.mjs` on agent-box polls `POST /shopper/next` on the Worker, runs `shopper/agent.mjs`
  (Claude through `POST /shopper/claude`, the browser through CDP on port 9222), and posts `/shopper/report`;
  the Worker writes the result to the Telegram chat.
- Services (systemd --user on agent-box, units in shopper/systemd): `shopper-xvfb`, `shopper-chrome`, `shopper`,
  and the remote view `shopper-vnc` (127.0.0.1:5900) + `shopper-view` (noVNC on the Tailscale IP, port 6080). Logs: `tail -f ~/.local/share/family-shopper/shopper.log`.
- See the browser: `http://100.71.148.71:6080/vnc.html` (the person logs in and passes Cloudflare there). Screenshot without it: `node shopper/shot.mjs /tmp/x.png`.
- Test one order without Telegram: `node shopper/try.mjs "חלב 3%" "ביצים L ×12"`.
- Site notes learned from real runs go in the sections above, so the next order is faster.
