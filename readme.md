# Subpath Router for example.com

## What this is, in plain terms

You have one main domain, `example.com`. Over time you want to add extra
websites at different "folders" of that domain — for example:

- `example.com/test` → a test website
- `example.com/blog` → a blog, added later
- `example.com/shop` → a shop, added even later

Each of those is its own separate website, built and deployed on its own by
a developer. This repo is **not** any of those websites. It's a small
"traffic director" that sits in front of all of them and sends each visitor
to the right one, based on the part of the URL after the domain name.

Think of it like a receptionist standing at the front door of a building
with several offices inside. A visitor says "I'm here for the Blog," and
the receptionist points them down the right hallway. This repo is the
receptionist. It never needs to change — you just update its list of
"which hallway leads to which office."

## The one-time setup (a developer does this)

A developer deploys this repo as one Cloudflare Worker. This is the only
time anyone needs to touch code. After this step, you manage everything
yourself through the Cloudflare dashboard — no code, no developer needed.

```
npm install
npx wrangler deploy
```

## How you add a new website yourself (no code, no developer)

Every time a developer finishes a new website and gives you its address
(it will look like `https://something.yourname.workers.dev`), do this:

### Step 1 — Add it to the list

1. Go to the Cloudflare dashboard → **Workers & Pages**.
2. Click this Worker (the one this repo deploys — e.g.
   `example-subpath-router`).
3. Click the **Settings** tab, then **Variables and Secrets**.
4. Find the variable named `ROUTES_JSON` and click the pencil/edit icon.
5. You'll see something like this:
   ```json
   { "/test": "https://pakrice-website.yourname.workers.dev" }
   ```
6. Add a comma, then your new line, keeping the same style:
   ```json
   {
     "/test": "https://pakrice-website.yourname.workers.dev",
     "/blog": "https://my-blog-worker.yourname.workers.dev"
   }
   ```
7. Click **Save and deploy**.

**Careful with the punctuation** — this is the only part that can go
wrong. Every path and address must be inside double quotes `" "`, each
line (except the last) must end with a comma, and the very last line must
**not** have a comma after it. If you're ever unsure, paste the whole
block into a free online "JSON validator" before saving — it will tell you
immediately if something's broken.

### Step 2 — Tell Cloudflare which web address should reach it

1. Still inside this Worker, click **Settings → Domains & Routes → Add
   Route**.
2. Route: `example.com/blog*` (replace `blog` with your new path, and
   keep the `*` at the end).
3. Zone: `example.com`.
4. Save.

### Step 3 — Test it

Open `example.com/blog` in your browser (use an incognito/private window,
so you don't see an old cached version). Click around a little to make
sure images and internal links work.

That's the whole process — two settings screens, no code, repeatable for
every future website.

## Things to know

- **One path must never be a piece of another.** `/test` and `/testing`
  are fine together. `/test` and `/test2` could get confusing — pick
  prefixes that are clearly distinct.
- **Removing a website later** is the same Step 1, just delete its line
  (and its comma) from `ROUTES_JSON`, then remove its Route in Step 2.
- **If a path stops working after an edit**, the most common cause is a
  small JSON typo in `ROUTES_JSON` — a missing comma or quote. Re-check it
  with a JSON validator.
- **This repo itself should rarely change.** If a developer ever says
  they need to edit `src/index.js` for a routine new website, that's a
  sign something's being done the hard way — adding a website should only
  ever require the two dashboard steps above.

## For the developer deploying each new website

Nothing about this router affects how you build or deploy your site. Build
and deploy it exactly as you normally would, as its own independent
Cloudflare Worker, with its own repo. The only thing you owe the site
owner afterwards is the Worker's `*.workers.dev` address, so they can add
it to `ROUTES_JSON` themselves.
