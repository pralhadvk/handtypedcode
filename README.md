# handtypedcode

Code typed by a human, one key at a time. Paste is turned off, every keystroke is recorded, and anyone can watch the replay.

- **Hosting:** Vercel (free Hobby plan). It's a plain static site with no build step.
- **Database and sign-in:** Supabase (free plan), using "Sign in with GitHub".
- **Without Supabase:** the editor and replay still work. Sign-in and the shared gallery switch on once you add your keys to `config.js`.

## What's in here

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `styles.css` | All styling (light and dark) |
| `app.js` | Editor, keystroke recording, replay player, gallery, profiles |
| `config.js` | Your Supabase URL and public key go here |
| `supabase/schema.sql` | Database tables, security rules and the server-side replay check |
| `vercel.json` | Makes share links like `/s/<id>` and `/u/<name>` work on Vercel |
| `serve.json` | Same routing when testing on your own computer |
| `favicon.svg` | Browser tab icon |

---

## Step 1: Put the code on GitHub

1. Create a free account at <https://github.com>.
2. Click **New repository**, name it `handtypedcode`, keep it Public or Private, and click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in every file and the `supabase` folder from this project, then click **Commit changes**.

   Using git in a terminal instead? Run this from inside this folder:

   ```bash
   git init
   git add .
   git commit -m "handtypedcode"
   git branch -M main
   git remote add origin https://github.com/<your-username>/handtypedcode.git
   git push -u origin main
   ```

## Step 2: Deploy on Vercel (free)

1. Go to <https://vercel.com> and sign up with GitHub. Choose the **Hobby** plan.
2. Click **Add New → Project**, find `handtypedcode`, and click **Import**.
3. Leave every setting as it is. The framework should say "Other" and no build command is needed. Click **Deploy**.
4. After about a minute your site is live at something like `handtypedcode.vercel.app`. Open it and type something. The editor and replay already work.

From now on, every change you push to GitHub redeploys the site automatically.

## Step 3: Connect handtypedcode.ink (Namecheap)

1. In Vercel, open your project → **Settings → Domains**. Add `handtypedcode.ink`, and also `www.handtypedcode.ink` when Vercel offers it.
2. Vercel shows the DNS records it needs. It's usually an **A record** for `@` and a **CNAME** for `www`. Use exactly the values Vercel shows you.
3. In Namecheap, go to **Domain List → Manage** (next to handtypedcode.ink) **→ Advanced DNS**.
   - Delete the default "parking page" records (the URL Redirect record and the CNAME for `www`).
   - Click **Add New Record** and enter each record from Vercel.
4. Wait 5–60 minutes. Vercel turns HTTPS on by itself once the domain is detected.

## Step 4: Create the database (Supabase, free)

1. Go to <https://supabase.com>, sign up, and click **New project**. Pick a name, a strong database password, and the region closest to you, for example Mumbai (ap-south-1).
2. When it's ready, open **SQL Editor → New query**. Paste the whole of `supabase/schema.sql` and click **Run**. You should see "Success". You can safely run it again after future changes.
3. Open **Project Settings → API** (called "API Keys" in some versions) and copy:
   - the **Project URL** (like `https://abcdefghijkl.supabase.co`)
   - the **anon** or **publishable** key. It's safe to publish. Never use the `service_role` / secret key.
4. Paste both into `config.js`:

   ```js
   window.HTC_CONFIG = {
     supabaseUrl: "https://abcdefghijkl.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."   // or "sb_publishable_..."
   };
   ```

5. Commit and push (or edit `config.js` directly on GitHub). Vercel redeploys.

## Step 5: Turn on "Sign in with GitHub"

1. In Supabase, open **Authentication → Sign In / Providers → GitHub** and turn it on. Copy the **Callback URL** it shows (it ends in `/auth/v1/callback`).
2. In a new tab, open GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Application name: `handtypedcode`
   - Homepage URL: `https://handtypedcode.ink`
   - Authorization callback URL: paste the Supabase callback URL
3. Click **Register application**. Copy the **Client ID**, then click **Generate a new client secret** and copy that too.
4. Back in Supabase, paste both into the GitHub provider settings and click **Save**.
5. In Supabase, open **Authentication → URL Configuration**:
   - **Site URL:** `https://handtypedcode.ink`
   - **Redirect URLs:** add `https://handtypedcode.ink/**`, `https://handtypedcode.vercel.app/**`, and `http://localhost:3000/**`

Now open your site, click **Sign in with GitHub**, type a snippet, and publish it. It should appear in the gallery. Each snippet gets a share link like `handtypedcode.ink/s/<id>`, and each person gets a profile at `handtypedcode.ink/u/<github-name>`.

---

## Testing on your own computer

With Node.js installed, run this from this folder:

```bash
npx serve .
```

Then open <http://localhost:3000>. `serve.json` makes the `/s/…` and `/u/…` links work locally, the same way `vercel.json` does on Vercel.

## How the anti-paste checks work

In the browser:

- Paste and drag-and-drop are blocked in the editor.
- Anything over 16 characters arriving in one step is removed. Whitespace from auto-indent is the only exception.
- Emoji aren't allowed. They would confuse the character counting the server uses to check replays.

On the server, in the `publish_snippet` function in `schema.sql`:

- It replays every keystroke and refuses to save unless the result matches the code exactly.
- It rejects any single step that adds more than 16 non-whitespace characters.
- It rejects recordings faster than 300 words per minute, or with no time between keys.
- It computes the stats (time, speed, fixes) itself, so nobody can edit them.
- It allows each person 30 snippets a day.
- It's the only way to add a snippet. The database rules block direct inserts and edits.

**The honest limit:** the recording is made in the visitor's browser, so a determined person could write a script that fakes realistic keystrokes. It could also retype AI-written code by hand. The checks stop casual cheating, not a dedicated faker. The site says this on every replay.

## Free-plan things to know

- **Vercel Hobby** is for personal, non-commercial projects. If you add ads or paid features, move to Pro.
- **Supabase free** gives a 500 MB database (roughly 10,000+ snippets) and 50,000 monthly active users. **The project pauses after about a week with no traffic.** Resume it from the Supabase dashboard, or upgrade once people are using it.

## Ideas for later

- A "✍️ hand-typed" badge people can add to their GitHub README, linking to their profile
- Preview images for share links (needs a small serverless function)
- Challenges ("FizzBuzz in under 2 minutes") and leaderboards
- Reporting and moderation tools once strangers start posting
