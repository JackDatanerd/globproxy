import type { BlogPost } from './types'

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'retarget-session-or-get-bandwidth-back',
    title: 'Wrong Location on Your Session? How to Retarget It or Get Your GB Back',
    description:
      'Created a session without choosing a country, or put all your GB on one session? You can change its location in place, release unused GB, or start over.',
    excerpt:
      'Nothing is lost. You can change a session\'s country, state or city without touching its bandwidth, or move unused GB back to your balance and create a new one.',
    category: 'Guides',
    publishedAt: '2026-10-27',
    body: [
      {
        type: 'p',
        text: 'It is easy to do on a first session: you click use all so the whole balance is ready, leave the country on Any country, and create it. Then you realise you wanted traffic exiting in one specific place, and every GB you own is sitting on a session that is not targeted there. Nothing has gone wrong and nothing is lost. This guide shows how to fix it, which option fits which situation, and why a release sometimes refuses.',
      },
      {
        type: 'table',
        headers: ['What you want', 'Do this', 'What happens to your GB'],
        rows: [
          ['Same session, different location', 'Edit tab: change country, state or city', 'Nothing. The GB stay on the session.'],
          ['A second session in another location', 'Release unused GB, then create a new session', 'Unused GB move back to your balance, then onto the new session.'],
          ['Throw the session away', 'Delete session', 'Unused GB return to your balance. GB already used are not refunded.'],
        ],
      },

      { type: 'h2', text: 'How your bandwidth is organised' },
      {
        type: 'p',
        text: 'There are two layers, and the confusion usually sits between them. The bandwidth you buy goes into your account balance. Your Overview page shows it as, for example, "of 20 GB purchased · 5 GB not yet assigned to a session". That second number is your unallocated balance. When you create a session you choose how much of the balance to allocate to it, and from then on those GB belong to that session. They come back to the balance only if you release them or delete the session.',
      },
      {
        type: 'p',
        text: 'Two things draw on the unallocated balance: creating a new session, and topping up an existing one from its Bandwidth tab. That is why a session holding everything leaves nothing for a second one until you release some.',
      },

      { type: 'h2', text: 'Option A: change the location in place' },
      {
        type: 'p',
        text: 'If the only problem is the location, you do not need your GB back at all. A session\'s location is stored as a setting and built into the username you connect with, so it can be changed without recreating anything:',
      },
      {
        type: 'ol',
        items: [
          'Open My Proxies and click the session to expand it.',
          'Open the Edit tab.',
          'Choose the Country, then State / region, then City you want. Leave a level on Any to keep it broad.',
          'Choose Save. You will see "Session updated".',
          'Open the Credentials tab and copy the username again, or copy a fresh snippet from the Code snippets tab.',
          'Put the new username into whatever was using the old one.',
        ],
      },
      {
        type: 'p',
        text: 'The Edit tab itself says it plainly: changes apply to new connections, and your bandwidth is not affected. Here is what actually changes for a rotating session:',
      },
      {
        type: 'code',
        language: 'text',
        caption: 'Before: created with Any country',
        code: 'gp_3f9a1c7e2b8d4a6f0c15-type-residential',
      },
      {
        type: 'code',
        language: 'text',
        caption: 'After: Edit tab set to United States, Texas, Austin',
        code: 'gp_3f9a1c7e2b8d4a6f0c15-type-residential-country-us-state-texas-city-austin',
      },
      {
        type: 'p',
        text: 'Anything still connecting with the old username keeps using the old behaviour until you swap the new one in. Once you do, run the cURL test from our connection guide to confirm the exit country. The same Edit tab can also change the label, protocol, rotating or sticky behaviour, and sticky duration. Changing protocol or IP behaviour changes the port too, so copy the whole connection again.',
      },

      { type: 'h3', text: 'How the location pickers work' },
      {
        type: 'ul',
        items: [
          'The order is fixed: Country, then State / region, then City. The City list stays disabled until a state or region is chosen, and changing the country clears the state and city below it.',
          'Every option comes from the network\'s supported locations, so a choice in the picker is always one the network recognises. There are around 26,000 cities across 207 countries; Texas alone lists 392, including Austin, Dallas and Houston.',
          'If a city is not in the list, it cannot be targeted. Pick the state or region instead.',
          '"State / region" means whatever the country uses: states in the United States, nations such as England and Scotland in the United Kingdom, counties in Kenya.',
          'A few territories have no region list, so you can target only the country. Right now these are Aruba, the Falkland Islands and Gibraltar.',
          'Under Advanced targeting you can also pick an ISP. It is offered only after a country is chosen, and an ISP that does not exist in that country is rejected rather than saved.',
        ],
      },
      {
        type: 'callout',
        title: 'Narrower is not always better',
        text: 'One city plus one ISP draws from a much smaller pool of IPs than a whole country. If a tightly targeted session is slow or failing, widen it first (drop the ISP, then the city) before assuming something else is wrong.',
      },

      { type: 'h2', text: 'Option B: get unused GB back and make a second session' },
      {
        type: 'p',
        text: 'Choose this when you want to keep the first session as it is and add another in a different location.',
      },
      {
        type: 'ol',
        items: [
          'Open the session and go to its Bandwidth tab.',
          'Find Release unused GB. The line above the box shows how much is releasable, for example "4.2 GB releasable · use max". Click it to fill in the maximum, or type an amount.',
          'Choose Release GB. A message confirms how many GB were returned to your balance.',
          'Create the new session from New session. Duplicate on the first session\'s card opens the same form pre-filled with its settings, so you only change the location.',
          'In GB to allocate, enter the amount you released (or less).',
        ],
      },
      {
        type: 'p',
        text: 'The session you released from keeps working with the same credentials. Only its allocation shrinks. A release never takes GB the session has already used, and it always leaves a small safety margin on top of that (about 0.05 GB), which is why you cannot release literally everything. The smallest release is 0.01 GB. If you want the whole allocation back, delete the session instead.',
      },
      { type: 'h3', text: 'When a release is refused' },
      {
        type: 'table',
        headers: ['Message or situation', 'Why', 'What to do'],
        rows: [
          [
            '"Releasing that much would immediately trigger auto-allocate"',
            'Auto-allocate is on, and the GB left after your release would be at or below its trigger level. It would top the session straight back up.',
            'Turn Auto-allocate off on the same Bandwidth tab and save, or release less. Note that new sessions copy your account-wide auto-allocate default, so a session you created with it on has it on.',
          ],
          [
            '"Only X GB can be released from this session right now"',
            'The rest is used or held as the safety margin.',
            'Release up to the figure shown, or use max.',
          ],
          [
            '"Could not confirm this session\'s live usage, so nothing was released"',
            'We refuse to release against a stale usage figure, in case it hands back GB you have actually consumed. This is temporary.',
            'Wait a minute and try again.',
          ],
          [
            'No Bandwidth tab on the session',
            'Paused and still-queued sessions do not show the tabs.',
            'If you paused it, choose Resume session first. If it is queued, wait for it to activate. Queued sessions have their GB reserved, and deleting one returns them.',
          ],
          [
            'Message about a reseller allocation',
            'A session allocated to you by a reseller cannot be changed or released by you.',
            'Ask the reseller who allocated it.',
          ],
        ],
      },

      { type: 'h2', text: 'Option C: delete it and start over' },
      {
        type: 'p',
        text: 'Deleting makes sense when the session is brand new, has used almost nothing, and you want clean credentials. Choose Delete session at the bottom of the expanded card and confirm. The card states the rule before you click: deleting returns the session\'s unused GB to your account, and GB already used are not refunded. After it succeeds you will see how many GB were returned.',
      },
      {
        type: 'p',
        text: 'Deleting also removes the endpoint, so anything connected to it stops working. If you only need a different location, Option A is almost always the better choice. If you do want a clean copy, press Duplicate before you delete so you have the settings ready.',
      },

      { type: 'h2', text: 'How to avoid this next time' },
      {
        type: 'ul',
        items: [
          'Start small. A new session defaults to 1 GB, and use all puts your entire unallocated balance on that one session. Top up later from the Bandwidth tab as you need it.',
          'Check the Country field before you create. Any country is the default and means the exit can be anywhere.',
          'Put the location in the label (for example "US Austin") so a list of sessions stays readable.',
          'Need several identical sessions? Number of sessions on the New session form creates 2, 3, 5, 10 or 20 at once, each with its own allocation, so size the GB per session accordingly.',
          'Keep Auto-allocate off until you want it. It is useful, but it is the usual reason a release refuses.',
        ],
      },
      {
        type: 'callout',
        title: 'Still not sure which option fits?',
        text: 'Open Support in the dashboard sidebar and tell us what you set up and what you wanted instead, including the session\'s label. We can usually point to the quickest fix straight away.',
      },
    ],
    faq: [
      {
        q: 'Do I lose any bandwidth by editing a session\'s location?',
        a: 'No. Editing changes only the session\'s settings. Its GB allocation, credentials and usage are untouched.',
      },
      {
        q: 'Will my IP change after I edit the location?',
        a: 'New connections use the new location, so on a rotating session you will start seeing IPs from the new place once you connect with the updated username. Connections already running with the old username keep their old behaviour until you swap it.',
      },
      {
        q: 'Can I release all the GB from a session?',
        a: 'Not quite. GB already used stay with the session, and a small safety margin always remains. To remove the whole allocation, delete the session instead, which returns whatever is unused.',
      },
      {
        q: 'Do released GB show up straight away?',
        a: 'Yes. They return to your unallocated balance as soon as the release succeeds. Refresh the page if the figure has not updated.',
      },
      {
        q: 'Does releasing change my credentials or interrupt the session?',
        a: 'No. The session keeps the same host, port, username and password. Only its allocation gets smaller.',
      },
      {
        q: 'Can I get back GB that were already used in the wrong location?',
        a: 'Used bandwidth cannot be moved back to your balance. If you think something went wrong on our side, contact support and include the session\'s label.',
      },
    ],
  },
  {
    slug: 'how-to-connect-to-globproxy-proxy',
    title: 'How to Connect to Your GlobProxy Proxy: A Step-by-Step Setup Guide',
    description:
      'Find your connection details, test with cURL, then set up Python, Node, Playwright, Puppeteer or a browser — plus fixes for the errors people hit first.',
    excerpt:
      'Four values, one test command, and you are connected. Where to find them, which port to use, and what to do when the first request fails.',
    category: 'Guides',
    publishedAt: '2026-10-27',
    body: [
      {
        type: 'p',
        text: 'Connecting a GlobProxy session takes four values and one test command. Nearly every failed first attempt comes from the same handful of mistakes: copying only part of the username, using the wrong port for the session type, or testing in the first few minutes before new credentials have finished syncing. This guide walks the whole path, then covers the errors people hit most.',
      },
      {
        type: 'p',
        text: 'One word to pin down first. In the dashboard, a session is one set of proxy credentials with its own GB allocation, listed under My Proxies. Sticky sessions (covered below) are named endpoints that live inside it.',
      },
      { type: 'h2', text: 'Before you start' },
      {
        type: 'p',
        text: 'You need a session with bandwidth on it. If you have not created one yet, buy bandwidth first, then go to My Proxies and choose New session. If your account has no unallocated GB, the New session page sends you to Buy Bandwidth instead.',
      },

      { type: 'h2', text: 'Step 1: Find your connection details' },
      {
        type: 'ol',
        items: [
          'Sign in and open My Proxies in the left sidebar.',
          'Click your session\'s row to expand it.',
          'Open the Credentials tab. It shows four fields: Host, Port, Username and Password. The password stays hidden until you click show.',
          'Use the copy button beside each field rather than retyping. The username is long, and everything after the first dash matters.',
        ],
      },
      {
        type: 'p',
        text: 'For a one-click version, the copy button (⧉) on the session row copies the whole endpoint in host:port:username:password form, which is the format most scraping tools and anti-detect browsers import.',
      },
      { type: 'h3', text: 'What the username is made of' },
      {
        type: 'p',
        text: 'The username is not just an ID. Your location choices are part of it, which is why a connection exits where you picked without any extra setup.',
      },
      {
        type: 'code',
        language: 'text',
        caption: 'A rotating session targeted to Austin, Texas (your base ID will differ)',
        code: 'gp_3f9a1c7e2b8d4a6f0c15-type-residential-country-us-state-texas-city-austin',
      },
      {
        type: 'ul',
        items: [
          'gp_3f9a… is your session\'s base ID.',
          '-type-residential is the network type.',
          '-country-us-state-texas-city-austin is the location. State and city are optional; an ISP appears as -asn-<number> if you chose one. A session created with Any country has no location part at all.',
        ],
      },
      {
        type: 'p',
        text: 'A sticky username adds two more parts that hold one exit IP for a set time:',
      },
      {
        type: 'code',
        language: 'text',
        code: 'gp_3f9a1c7e2b8d4a6f0c15-type-residential-country-us-state-texas-city-austin-lifetime-60-session-Ab3dE9xQ',
      },
      {
        type: 'p',
        text: '-lifetime-60 is how many minutes the IP is held, and -session-Ab3dE9xQ identifies that one sticky IP. Because location lives in the username, changing a session\'s location later means copying the username again. Anything still using the old one keeps the old location.',
      },

      { type: 'h2', text: 'Step 2: Use the right port' },
      {
        type: 'table',
        headers: ['Protocol', 'IP behaviour', 'Port', 'Typically used for'],
        rows: [
          ['HTTP / HTTPS', 'Rotating', '9000', 'Scrapers, browsers and most libraries'],
          ['HTTP / HTTPS', 'Sticky', '10000', 'Logins and multi-step flows that must keep one IP'],
          ['SOCKS5', 'Rotating', '11000', 'Tools that only speak SOCKS5'],
          ['SOCKS5', 'Sticky', '12000', 'The same, with a fixed IP'],
        ],
      },
      {
        type: 'p',
        text: 'You do not pick a port freely. It is fixed by the protocol and IP behaviour chosen for the session, and the Credentials tab always shows the matching one. Pairing a username with the wrong port is a common reason for a request that hangs or resets, so use the port on the card.',
      },

      { type: 'h2', text: 'Step 3: Test with one command' },
      {
        type: 'p',
        text: 'Before touching your own code, confirm the proxy works. This request asks a public service which IP it sees:',
      },
      {
        type: 'code',
        language: 'bash',
        code: 'curl -x "http://YOUR_USERNAME:YOUR_PASSWORD@proxy.globproxy.com:9000" https://ipinfo.io/json',
      },
      {
        type: 'p',
        text: 'For a SOCKS5 session, change the scheme and port: socks5h://…@proxy.globproxy.com:11000. The h makes the proxy resolve DNS, so your own resolver is not involved.',
      },
      {
        type: 'callout',
        title: 'On Windows PowerShell, type curl.exe',
        text: 'In Windows PowerShell, plain curl is an alias for a different command and rejects the -x option. Use curl.exe instead, or run the command in Command Prompt or Git Bash.',
      },
      {
        type: 'p',
        text: 'You should get a small JSON reply with an ip, plus city, region and country. Check the country against your targeting. Public geolocation databases are estimates, so a nearby town in the reply does not mean targeting failed, but a different country does. On a rotating session, running the command twice should show two different IPs.',
      },

      { type: 'h2', text: 'Step 4: Set it up in your tool' },
      {
        type: 'p',
        text: 'The Code snippets tab on each session generates all of the following with your real values already filled in. Copy from there when you can. The examples below show the shape with placeholders.',
      },
      { type: 'h3', text: 'Python (requests)' },
      {
        type: 'code',
        language: 'python',
        code: `import requests

proxy = "http://YOUR_USERNAME:YOUR_PASSWORD@proxy.globproxy.com:9000"
proxies = {"http": proxy, "https": proxy}

response = requests.get("https://ipinfo.io/json", proxies=proxies, timeout=30)
print(response.json())  # shows your proxy IP and location`,
      },
      {
        type: 'p',
        text: 'For SOCKS5, install pip install "requests[socks]" and use socks5h://YOUR_USERNAME:YOUR_PASSWORD@proxy.globproxy.com:11000 as the proxy value.',
      },
      { type: 'h3', text: 'Node.js' },
      {
        type: 'code',
        language: 'javascript',
        caption: 'npm install https-proxy-agent node-fetch@2',
        code: `const { HttpsProxyAgent } = require("https-proxy-agent");
const fetch = require("node-fetch");

const agent = new HttpsProxyAgent(
  "http://YOUR_USERNAME:YOUR_PASSWORD@proxy.globproxy.com:9000"
);

(async () => {
  const res = await fetch("https://ipinfo.io/json", { agent });
  console.log(await res.json()); // shows proxy IP and location
})();`,
      },
      { type: 'h3', text: 'Playwright and Puppeteer' },
      {
        type: 'p',
        text: 'Both drive Chromium, which cannot authenticate to a SOCKS5 proxy. Use a session set to HTTP / HTTPS for browser automation. You can change an existing session\'s protocol on its Edit tab.',
      },
      {
        type: 'code',
        language: 'javascript',
        caption: 'Playwright — npm install playwright',
        code: `const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    proxy: {
      server: "http://proxy.globproxy.com:9000",
      username: "YOUR_USERNAME",
      password: "YOUR_PASSWORD",
    },
  });
  const page = await browser.newPage();
  await page.goto("https://ipinfo.io/json");
  console.log(await page.textContent("body"));
  await browser.close();
})();`,
      },
      {
        type: 'code',
        language: 'javascript',
        caption: 'Puppeteer — npm install puppeteer',
        code: `const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    args: ["--proxy-server=http://proxy.globproxy.com:9000"],
  });
  const page = await browser.newPage();
  await page.authenticate({ username: "YOUR_USERNAME", password: "YOUR_PASSWORD" });
  await page.goto("https://ipinfo.io/json");
  console.log(await page.evaluate(() => document.body.innerText));
  await browser.close();
})();`,
      },
      { type: 'h3', text: 'A regular browser' },
      {
        type: 'p',
        text: 'A browser\'s own proxy settings do not take a username and password in one place, so a proxy-switching extension such as Proxy SwitchyOmega (Chrome and Firefox) is the simplest route. Enter:',
      },
      {
        type: 'table',
        headers: ['Field', 'Value'],
        rows: [
          ['Protocol', 'HTTP'],
          ['Host', 'proxy.globproxy.com'],
          ['Port', '9000 (or the port on your Credentials tab)'],
          ['Username', 'The full username from Step 1'],
          ['Password', 'Your session password'],
        ],
      },
      { type: 'h3', text: 'Scrapers, anti-detect browsers and other tools' },
      {
        type: 'p',
        text: 'Most of these accept one line per proxy in host:port:username:password form:',
      },
      {
        type: 'code',
        language: 'text',
        code: 'proxy.globproxy.com:9000:gp_3f9a1c7e2b8d4a6f0c15-type-residential-country-us:YOUR_PASSWORD',
      },
      {
        type: 'p',
        text: 'On a rotating session, the Endpoint tab has copy all and .txt buttons that produce exactly this. On a sticky session, the Sticky sessions tab has the same for every named session. Treat the downloaded file like a password, because it contains one.',
      },

      { type: 'h2', text: 'Rotating or sticky: which endpoint am I using?' },
      {
        type: 'p',
        text: 'A rotating endpoint gives each new connection a fresh IP. One endpoint serves any number of simultaneous connections, so there is no need to create several; they all draw from the same session bandwidth.',
      },
      {
        type: 'p',
        text: 'A sticky session holds one IP for its lifetime, which you can set from 1 minute to 24 hours. On a sticky session, the username on the Credentials tab is only a ready-made example. Open the Sticky sessions tab and choose + new session (you can create 1, 5, 10 or 25 at once, up to 200 per session). Each named session is its own fixed endpoint with its own IP. Remove hides one from the list but its IP keeps working until the lifetime ends; Delete frees the endpoint.',
      },

      { type: 'h2', text: 'If it does not connect' },
      {
        type: 'table',
        headers: ['What you see', 'Likely cause', 'What to do'],
        rows: [
          [
            '407 Proxy Authentication Required in the first minutes',
            'New credentials take a few minutes to sync across the network. The card shows warming up for about 10 minutes after activation.',
            'Wait a couple of minutes and retry. If it persists past 10 minutes, re-copy the username and password.',
          ],
          [
            '407 that never goes away',
            'The username or password is incomplete or out of date. Most often the username was truncated, or the password was rotated after you copied it (rotating invalidates the old one at once).',
            'Re-copy both values in full from the Credentials tab.',
          ],
          [
            'Request hangs, is refused or resets',
            'Wrong port or protocol (for example a SOCKS5 client on an HTTP port), or your network blocks outbound traffic on that port.',
            'Use the port shown on the card. Try from a different network to rule out a firewall.',
          ],
          [
            'Exit IP is in the wrong country or city',
            'Location lives in the username. You may be using a copy from before an edit, or the session was created with Any country.',
            'Open the Edit tab, check Country, State and City, save, then copy the username again. Changes apply to new connections only.',
          ],
          [
            'Session says it is queued',
            'The network is adding capacity. Your GB is already reserved.',
            'Nothing. It activates on its own.',
          ],
          [
            'Red banner: not responding on our network',
            'A fault on our side. We are alerted and your bandwidth is safe.',
            'Retry in a while. Contact support if it lasts.',
          ],
          [
            'Nothing works and Remaining shows 0 GB',
            'The session\'s allocation is used up.',
            'On the Bandwidth tab, top up from your unallocated balance, or buy more bandwidth first.',
          ],
          [
            'Session shows as paused',
            'It was paused, by you or by GlobProxy.',
            'If you paused it, open the session and choose Resume session. If GlobProxy paused it, contact support.',
          ],
          [
            'Playwright or Puppeteer fails on a SOCKS5 session',
            'Chromium cannot authenticate to SOCKS5.',
            'Use an HTTP / HTTPS session for browser automation.',
          ],
          [
            'Stopped working after changes on the Whitelist tab',
            'Whitelist entries are the one thing in this guide you may have changed beyond the four credentials.',
            'Remove the entries, retest, and contact support if the problem remains.',
          ],
        ],
      },

      { type: 'h2', text: 'Keep your password private' },
      {
        type: 'p',
        text: 'The password sits inside connection strings, which tend to end up in shell history, logs and repositories. Read it from an environment variable or secret store instead of hard-coding it. If it leaks, open the Credentials tab and choose Rotate password. The old password stops working immediately, so update everything that used it. Rotation is only offered where it is currently available.',
      },
      {
        type: 'callout',
        title: 'Still stuck?',
        text: 'Open Support in the dashboard sidebar and quote the session\'s label. Include the exact error and the output of the Step 3 test, with the password removed. That is usually enough for us to find the cause without a back-and-forth.',
      },
    ],
    faq: [
      {
        q: 'Do I need to whitelist my IP to connect?',
        a: 'No. The setup in this guide uses only the username and password from the Credentials tab. There is no whitelist step.',
      },
      {
        q: 'Should I choose HTTP or SOCKS5?',
        a: 'HTTP / HTTPS works with browsers and almost every library, and it is the only option for Playwright and Puppeteer. Choose SOCKS5 only for tools that specifically require it.',
      },
      {
        q: 'Can several machines or threads use the same endpoint at once?',
        a: 'Yes. One rotating endpoint serves any number of simultaneous connections. They all use the same session bandwidth, so heavy parallel use draws it down faster.',
      },
      {
        q: 'Why does my IP change on every request?',
        a: 'That is what a rotating session does. If you need the same IP across requests, use a sticky session and connect through one of its named sessions.',
      },
      {
        q: 'Will changing a session\'s location break connections already running?',
        a: 'Editing a session\'s location does not touch your bandwidth, and it applies to new connections. Anything still using the old username keeps the old location until you swap in the new one.',
      },
      {
        q: 'Does it work with HTTPS websites?',
        a: 'Yes. The examples above request an HTTPS address through an HTTP proxy port, which tunnels the encrypted connection.',
      },
    ],
  },
  {
    slug: 'non-expiring-proxy-bandwidth',
    title: 'Why Your Residential Proxy Bandwidth Keeps Expiring (And What It Actually Costs You)',
    description:
      'Most residential proxy plans reset unused GB every month. Here is how that math works against you, and how to check whether a provider actually lets bandwidth roll over.',
    excerpt:
      'Monthly-reset bandwidth quietly resets your account to zero every 30 days whether you used it or not. Here is the real cost of that model, and how to spot it before you buy.',
    category: 'Bandwidth & Pricing',
    publishedAt: '2026-08-03',
    body: [
      {
        type: 'p',
        text: "Most residential proxy plans are sold as subscriptions: you pay monthly, you get a GB allowance, and at the end of the billing cycle whatever you didn't use disappears. The plan resets to zero and the clock starts again. This is standard in the industry, not a hidden trick — but it's rarely explained in terms of what it actually costs a buyer whose usage isn't perfectly steady month to month.",
      },
      { type: 'h2', text: 'The math nobody puts on the pricing page' },
      {
        type: 'p',
        text: "Say you're on a 100 GB/month plan and your actual usage looks like this: 40 GB in a slow month, 140 GB in a busy one, 70 GB the month after. Under a monthly-reset model, the slow month wastes 60 GB outright — gone, non-refundable, non-transferable. The busy month either throttles you or forces an overage purchase at whatever rate the provider charges for going over. You end up paying for peak capacity every month, even in the months you don't use it.",
      },
      {
        type: 'p',
        text: "Over a year, for anyone whose workload isn't a perfectly flat, predictable 100 GB every single month — which describes most real usage, whether that's seasonal ad verification, sporadic scraping jobs, or client work that ebbs and flows — the wasted allowance adds up to real money spent on bandwidth that was purchased and never touched.",
      },
      { type: 'h2', text: 'Why providers default to monthly reset' },
      {
        type: 'p',
        text: "It's not malicious — it's a billing and infrastructure convenience. Subscription billing is predictable revenue, and resetting balances monthly is simpler to account for than tracking a rolling, non-expiring balance per user indefinitely. For the provider, it's the easier system to build. For the buyer, it means the incentive to actually use every GB you paid for resets on a clock you don't control.",
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'What "non-expiring" means on GlobProxy',
        text: "Bandwidth you buy stays on your account balance indefinitely — there's no monthly reset, no use-it-or-lose-it window, and no overage tier. A 100 GB purchase is 100 GB whenever you draw it down, whether that's this week or eight months from now.",
      },
      { type: 'h2', text: 'What to actually check before you buy' },
      {
        type: 'ul',
        items: [
          "Search the provider's terms or pricing FAQ for the words \"expire,\" \"reset,\" or \"rollover\" — plans that don't expire bandwidth usually say so explicitly, because it's a selling point, not a footnote.",
          'Ask what happens to unused GB specifically at renewal — a vague "your plan renews monthly" answer is a soft way of saying it resets.',
          "Check whether pay-as-you-go and subscription tiers are priced differently — some providers only offer non-expiring bandwidth on their most expensive tier, which defeats the purpose for smaller buyers.",
          'Confirm whether overage bandwidth (going over your allowance mid-cycle) is billed at the same rate as your plan or a punitive top-up rate — this is where a lot of the real cost hides.',
        ],
      },
      {
        type: 'p',
        text: "None of this means subscription pricing is a bad model for every use case — if your usage really is flat and predictable every month, the difference is small. But for anyone whose workload varies, non-expiring bandwidth changes the math from \"pay for your peak, every month\" to \"pay for what you actually use, whenever you use it.\"",
      },
    ],
    faq: [
      {
        q: 'Does non-expiring proxy bandwidth cost more per GB than subscription plans?',
        a: 'Not necessarily. Pay-as-you-go and non-expiring models are priced per GB directly, and the per-GB rate typically drops at higher volume tiers just like subscription plans do — the difference is what happens to bandwidth you buy but don\'t use in a given period, not the sticker price.',
      },
      {
        q: 'Can I check my remaining non-expiring balance at any time?',
        a: 'On GlobProxy, your GB balance is visible in the dashboard at all times and never resets — what you see is what you have, regardless of how long ago you purchased it.',
      },
    ],
  },
  {
    slug: 'city-level-proxy-targeting-explained',
    title: 'City-Level Proxy Targeting: What It Actually Means (And When You Need It vs. Country-Level)',
    description:
      'Country-level proxy targeting is enough for most tasks. Here is exactly when city-level targeting matters, how it works technically, and how to tell if a provider\'s "city targeting" is real.',
    excerpt:
      'Not every task needs a proxy in a specific city — but for the ones that do, the difference between real and approximate targeting is the whole ballgame.',
    category: 'Geo-Targeting',
    publishedAt: '2026-08-05',
    body: [
      {
        type: 'p',
        text: 'Geo-targeting for residential proxies comes in layers: country, region/state, and city. Most providers cover country-level cleanly. Fewer cover city-level with any real precision, because it requires a much denser, better-mapped IP pool — you need enough residential IPs actually located in a given city to make the targeting meaningful, not just a rough approximation based on the nearest available IP.',
      },
      { type: 'h2', text: 'When country-level targeting is genuinely enough' },
      {
        type: 'ul',
        items: [
          'General web scraping where you need to appear domestic to a country, not a specific region within it',
          'Market research where regional variation inside a country is not something the task cares about',
          "Bypassing country-based content restrictions or geo-blocked catalogs",
          'Most ad verification tasks where the ad platform is only targeting at the country level in the first place',
        ],
      },
      { type: 'h2', text: 'When city-level targeting is the actual requirement' },
      {
        type: 'ul',
        items: [
          "Local SEO rank tracking — Google's local results (map pack, local organic results) differ block by block in some markets, and a country-level IP will show you the wrong SERP entirely",
          'Geo-targeted ad verification for campaigns that target specific metro areas, not just a country',
          'Testing how a site or app behaves for users in a specific market — pricing, inventory, or content that varies city to city',
          'Account management workflows where consistent, believable location signals matter for trust or fraud systems tied to a metro area',
        ],
      },
      { type: 'h2', text: 'How to tell if "city targeting" is real' },
      {
        type: 'p',
        text: "This is the part worth being skeptical about. Some providers advertise city targeting but are actually assigning the nearest available IP within the country and labeling it with the requested city — functionally country-level targeting with a city name attached. A few checks that separate the real thing from the marketing claim:",
      },
      {
        type: 'ol',
        items: [
          "Ask (or check the docs) whether city selection is a dropdown of specific, named cities with real IP density behind each one, or a free-text field that silently falls back to nearest-match",
          'Check whether the same city selection is reflected consistently across sessions — inconsistent results on repeated requests to the same city is a sign the targeting is approximate',
          'Look at how many cities are actually listed per country — a handful of major cities per country suggests real density; hundreds of tiny towns listed for every country is often a sign the list was generated from a geography database, not from actual IP coverage',
        ],
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'How GlobProxy handles it',
        text: "City, state, and country selections are structured dropdowns sourced from the underlying network's actual supported locations — not free-text fields that silently fall back to a nearest match. If a city isn't in the list, it isn't offered as an option.",
      },
    ],
    faq: [
      {
        q: 'Does city-level targeting cost more than country-level?',
        a: "On GlobProxy, city and country targeting are priced the same — you're paying for bandwidth, not for the precision of the geo-selection.",
      },
      {
        q: 'How many cities does GlobProxy support?',
        a: 'Coverage spans 195 countries with city-level selection available in markets where the underlying network has real IP density — see the dashboard\'s location picker for the current list for any given country.',
      },
    ],
  },
  {
    slug: 'rotating-vs-sticky-sessions',
    title: 'Rotating vs. Sticky Proxy Sessions: A Practical Guide to Choosing the Right One',
    description:
      'Rotating and sticky residential proxy sessions solve opposite problems. Here is how each one works, when to use which, and what happens if you pick wrong.',
    excerpt:
      'One gives you a fresh IP on every request. The other holds one IP for the length of a session. Picking the wrong one is the most common reason a working proxy setup starts failing.',
    category: 'Guides',
    publishedAt: '2026-08-07',
    body: [
      {
        type: 'p',
        text: 'Rotating and sticky sessions are the two basic modes almost every residential proxy task falls into, and they solve opposite problems. Getting this choice wrong is one of the most common reasons a proxy setup that should work starts failing — not because the proxies are bad, but because the session type doesn\'t match what the target site expects to see.',
      },
      { type: 'h2', text: 'Rotating sessions: a new IP on every request (or on a timer)' },
      {
        type: 'p',
        text: "A rotating session assigns a different IP address automatically — either on every single request, or on a set interval you configure. The identity behind each request is disposable. This is the right mode when the task is high-volume and stateless: you're not trying to look like one consistent visitor over time, you're trying to spread a large number of requests across many different IPs so no single IP takes on a suspiciously high request volume.",
      },
      {
        type: 'ul',
        items: [
          'Large-scale scraping where you need volume more than continuity',
          'Price monitoring across many product pages where each check is independent',
          'General market research and data collection where session continuity doesn\'t matter',
        ],
      },
      { type: 'h2', text: 'Sticky sessions: one IP held for the length of a session' },
      {
        type: 'p',
        text: "A sticky session holds a single IP for a defined window — long enough to complete a login, a multi-step checkout, or a full browsing session that a site expects to come from one consistent location. Switching IPs mid-session on a site that tracks session continuity (many login flows, checkout flows, and account-bound platforms do) reads as suspicious — an account login from one city followed by an action from a different one, seconds later, is a common fraud-detection trigger.",
      },
      {
        type: 'ul',
        items: [
          'Account management and social media platforms where consistent location signals matter',
          'Any multi-step flow — login, cart, checkout — that needs to look like one continuous visit',
          'Sneaker/release automation where a session needs to persist through a full purchase flow',
        ],
      },
      { type: 'h2', text: 'How to decide, in practice' },
      {
        type: 'p',
        text: 'Ask one question: does this task involve more than one request that needs to look like it came from the same visitor? If yes, sticky. If every request stands alone and volume matters more than continuity, rotating. Some workflows genuinely need both — rotating for the discovery/scraping phase, sticky for the account-bound phase that follows — which is why it\'s worth checking a provider supports switching between the two on the same underlying IP pool rather than treating them as separate products.',
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'On GlobProxy',
        text: 'Every proxy session supports both rotating and sticky modes from the same dashboard — no separate purchase or plan tier required to switch between them.',
      },
    ],
    faq: [
      {
        q: 'How long can a sticky session last?',
        a: 'Sticky session duration is configurable per session from the dashboard, long enough to cover typical login-to-checkout flows without the IP changing mid-task.',
      },
      {
        q: 'Does switching between rotating and sticky cost extra?',
        a: 'No — both session types draw from the same non-expiring GB balance, priced identically.',
      },
    ],
  },
  {
    slug: 'ad-verification-geo-targeted-proxies',
    title: 'How to Verify Geo-Targeted Ads Are Actually Showing the Right Creative in the Right City',
    description:
      'Geo-targeted ad campaigns fail silently more often than advertisers realize. Here is how to actually verify what your ads look like in the markets you are paying to target.',
    excerpt:
      'A campaign set to target three cities can be quietly showing the wrong creative, the wrong price, or a competitor\'s ad in one of them — and nothing in the ad platform\'s dashboard will tell you.',
    category: 'Use Cases',
    publishedAt: '2026-08-09',
    body: [
      {
        type: 'p',
        text: "Ad platforms let you set geo-targeting at the campaign level, but what actually renders for a user in a given city depends on more than your targeting settings — creative rotation, competing bids, local inventory, and platform-side serving logic all affect what a real person in that city sees. The only way to know for certain is to actually look from an IP that's really located there.",
      },
      { type: 'h2', text: 'What silently goes wrong without verification' },
      {
        type: 'ul',
        items: [
          "The wrong creative variant serving in a city where a locally-relevant version was supposed to run",
          "Pricing or promo copy that's stale or mismatched to a local campaign that launched or changed on the platform side without your team seeing it directly",
          'A competitor outbidding you in a specific metro while your dashboard still shows the campaign as "delivering normally" nationally',
          "Landing pages that don't localize correctly for users arriving from a specific city, even when the ad itself is correct",
        ],
      },
      {
        type: 'p',
        text: 'None of these show up in the ad platform\'s own reporting, because the platform is reporting on delivery and spend, not on what a real user in a real city actually saw when the ad rendered.',
      },
      { type: 'h2', text: 'What real verification looks like' },
      {
        type: 'ol',
        items: [
          'Route a request through a residential IP genuinely located in each target city — not just the target country',
          'Load the ad (or the platform surface it appears on) exactly as a user in that city would, including any city-dependent personalization',
          'Screenshot or log what actually renders — creative, price, landing page — per city, on a recurring schedule rather than a one-time check',
          'Compare across cities in the same campaign to catch inconsistencies that a single-market check would miss entirely',
        ],
      },
      {
        type: 'p',
        text: 'This only works if the targeting is real city-level targeting, not an approximation — a proxy that claims a city but is actually serving the nearest available IP in the country will show you the wrong thing and you won\'t know it\'s wrong.',
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'For recurring verification',
        text: 'Sticky sessions hold a consistent city-level IP long enough to complete a full page load and any personalization that depends on it, which matters if the verification check involves more than a single request.',
      },
    ],
    faq: [
      {
        q: 'Do I need a different proxy for every city I want to verify?',
        a: 'No — you select the city per session from the same account and balance, so verifying five cities in one campaign is five session configurations, not five separate purchases.',
      },
      {
        q: 'How often should geo-targeted ad verification run?',
        a: 'For active campaigns, a recurring check (weekly or aligned to creative refresh cycles) catches drift that a one-time launch check will miss.',
      },
    ],
  },
  {
    slug: 'local-seo-rank-tracking-proxies',
    title: 'Local Rank Tracking Without Getting Flagged: A Proxy Setup Guide',
    description:
      'Google\'s local search results vary by city, sometimes by neighborhood. Here is how to track local rankings accurately without triggering automated-traffic detection.',
    excerpt:
      'The rank your client sees from their office is not the rank a customer sees three miles away. Accurate local tracking means checking from where the customer actually is.',
    category: 'Use Cases',
    publishedAt: '2026-08-11',
    body: [
      {
        type: 'p',
        text: "Local search results are personalized by location down to a granularity that surprises a lot of people running rank tracking for the first time — the map pack and local organic results a business sees ranking for \"plumber near me\" can differ meaningfully across a metro area, not just across countries. Checking rank from one fixed location (an office IP, a home connection, a single datacenter server) gives you an accurate answer for that one point on the map and an inaccurate one for everywhere else.",
      },
      { type: 'h2', text: 'Why this trips up rank tracking specifically' },
      {
        type: 'ul',
        items: [
          "A business's rank in the map pack for its own neighborhood can look completely different from its rank three miles away — exactly the difference a client cares about if they're trying to win customers across a service area, not just next door",
          "Search engines actively try to detect and rate-limit automated, repetitive query patterns — the same query, run repeatedly from the same IP, at a frequency no real user would search at, is a recognizable pattern",
          'A tracking setup that gets flagged doesn\'t just fail loudly — it can start returning degraded or inconsistent results before you notice anything is wrong',
        ],
      },
      { type: 'h2', text: 'A setup that holds up' },
      {
        type: 'ol',
        items: [
          'Track from residential IPs actually located in the geography being measured, at city-level precision — not a datacenter IP with a spoofed location header',
          'Rotate IPs across check cycles so repeated queries for the same keyword aren\'t all coming from one fixed address',
          'Space out request timing to resemble how real, distinct users would search — batching hundreds of queries in seconds from one IP is the pattern that gets flagged fastest',
          'Track the specific cities or neighborhoods that actually matter to the business, not just the metro-wide average — that\'s where the real client-facing insight is',
        ],
      },
      {
        type: 'p',
        text: "This is also where non-expiring bandwidth matters in a way that's easy to underestimate: rank tracking volume is naturally uneven — heavier around reporting cycles, lighter between them — and a monthly-reset bandwidth plan penalizes exactly that pattern.",
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'Practical starting point',
        text: 'Start with rotating sessions for the query volume itself, targeted at city-level, and treat each tracked location as its own configuration rather than one broad country-level setting.',
      },
    ],
    faq: [
      {
        q: 'Can I track rankings for multiple cities under one account?',
        a: 'Yes — city selection happens per session, so tracking ten cities across a service area is ten session configurations against one GB balance, not ten separate accounts or plans.',
      },
      {
        q: 'Does non-expiring bandwidth matter for rank tracking specifically?',
        a: 'It matters more than for steady-volume tasks — rank tracking load is naturally uneven around reporting cycles, and a plan that resets monthly effectively charges for peak capacity every month regardless of that variance.',
      },
    ],
  },
  {
    slug: 'social-media-management-proxies',
    title: 'Managing Multiple Social Accounts Without Cross-Contamination: The Proxy Layer, Explained',
    description:
      'Running several social accounts from one IP is the single fastest way to get them linked and flagged together. Here is how a proper proxy layer actually prevents that.',
    excerpt:
      'Platforms link accounts by more than login credentials — shared IPs, shared device fingerprints, and inconsistent location signals are the tells. The proxy layer is where most of that risk lives.',
    category: 'Use Cases',
    publishedAt: '2026-08-13',
    body: [
      {
        type: 'p',
        text: "Social platforms don't need you to log in with the same credentials to connect two accounts as related — a shared IP address across accounts that are supposed to be independent is one of the clearest signals a trust-and-safety system looks for. This is the core reason multi-account management needs a dedicated proxy layer, not a workaround, and it's also the most common place teams get the setup wrong.",
      },
      { type: 'h2', text: 'What actually links accounts together' },
      {
        type: 'ul',
        items: [
          'Multiple accounts logging in or posting from the same IP within a short window of each other',
          'An account\'s location signal jumping inconsistently between sessions — logged in from one city, active from another, minutes apart',
          'IP addresses with a known history of high account-creation volume (datacenter ranges and some shared/free proxy pools are heavily flagged for exactly this)',
          'Session behavior that doesn\'t match a plausible single user — no proxy setup fixes this on its own, but a bad proxy setup makes an otherwise-careful workflow fail anyway',
        ],
      },
      { type: 'h2', text: 'The setup that holds up over time' },
      {
        type: 'ol',
        items: [
          'One dedicated sticky session per account, held for the length of that account\'s activity window — not shared, not rotated mid-session',
          'A residential IP, not a datacenter one — residential IPs carry far less of the "known automation source" history that gets flagged on sight',
          'Consistent city-level location per account across sessions, rather than a different city every login — an account that appears to teleport between cities is its own red flag independent of shared-IP detection',
          'Enough distinct IPs in rotation across your full account roster that no two managed accounts are ever sharing the same address',
        ],
      },
      {
        type: 'p',
        text: 'None of this guarantees an account never gets flagged — platform detection systems weigh many signals beyond IP — but a proxy layer that gets the fundamentals above right removes IP-sharing as a cause, which is one of the most preventable ones.',
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'Sizing bandwidth for this use case',
        text: "Account management workloads tend to be steady rather than bursty, which makes them one of the cases where subscription-style plans look fine on paper — but non-expiring bandwidth still avoids paying for idle capacity on accounts that go quiet for a stretch.",
      },
    ],
    faq: [
      {
        q: 'How many accounts can one proxy plan support?',
        a: 'That\'s a function of GB usage, not a hard account cap — each account\'s sticky session draws from the same non-expiring balance, so the practical limit is your total bandwidth, not a per-account fee.',
      },
      {
        q: 'Should every account use a different city?',
        a: 'Not necessarily — match the city to what\'s plausible for that account\'s actual context, and keep it consistent across sessions rather than changing it session to session.',
      },
    ],
  },
  {
    slug: 'iproyal-alternative-non-expiring-bandwidth',
    title: 'Looking for an IPRoyal Alternative? Here Is How the Non-Expiring Bandwidth Math Compares',
    description:
      'A direct, honest comparison of GlobProxy and IPRoyal on the dimension that actually varies most between residential proxy providers: what happens to bandwidth you buy but do not use.',
    excerpt:
      'IPRoyal is a solid pay-as-you-go option with a real non-expiring pitch of its own. Here is where GlobProxy differs, and where it does not.',
    category: 'Comparisons',
    publishedAt: '2026-08-15',
    body: [
      {
        type: 'p',
        text: "IPRoyal has built a genuine reputation on accessible, pay-as-you-go residential proxy pricing with non-expiring traffic — it's a real competitor on the exact dimension GlobProxy leads with, not a strawman. This isn't a \"they trap you in subscriptions and we don't\" comparison, because that's not accurate. The honest comparison is narrower: pricing structure, geo-targeting depth, and what's included at entry-level volume.",
      },
      { type: 'h2', text: 'Where the two are genuinely similar' },
      {
        type: 'p',
        text: 'Both providers let you buy bandwidth without a recurring subscription and without a use-it-or-lose-it monthly window. If non-expiring bandwidth is the primary thing you\'re shopping for, both are legitimate options — the differences that matter are elsewhere.',
      },
      { type: 'h2', text: 'Where to actually compare' },
      {
        type: 'table',
        headers: ['Dimension', 'What to check on either provider', 'GlobProxy specifics'],
        rows: [
          ['Entry price point', 'Total cost to get started, not just the headline per-GB rate', 'Micro plan: 1 GB for $4.50 total, no minimum commitment'],
          ['Per-GB rate at volume', 'Rate at the tier you\'ll actually buy, not the lowest advertised tier', 'Drops to $2.00/GB at the 500 GB Scale tier'],
          ['Geo-targeting depth', 'Whether city selection is a real dropdown backed by IP density, or an approximate fallback', 'Structured country/state/city selection sourced from actual network coverage, not free text'],
          ['Session types', 'Whether rotating and sticky are both included, or sticky costs extra', 'Both included on every plan, switchable per session'],
          ['Payment methods', 'Card-only vs. broader payment support', 'Card and mobile money via Paystack'],
          ['Reseller/API access', 'Whether white-label reselling is a supported, documented path', 'Dedicated reseller program with a documented API for sub-user and bandwidth management'],
        ],
      },
      {
        type: 'p',
        text: "Pricing on any proxy provider moves — check both providers' current pricing pages directly before deciding, rather than relying on a comparison page (this one included) as the final word.",
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'The honest takeaway',
        text: "If non-expiring bandwidth is the deciding factor, that's not a reason to pick GlobProxy over IPRoyal specifically — both offer it. The deciding factors are geo-targeting precision, session flexibility, payment method support, and whether a reseller path matters to you.",
      },
    ],
    faq: [
      {
        q: 'Does GlobProxy support the same payment methods as IPRoyal?',
        a: 'GlobProxy processes payments through Paystack, supporting both card and mobile money — check IPRoyal\'s current payment page directly for their supported methods, since this varies by provider and region.',
      },
      {
        q: 'Is city-level targeting available on GlobProxy\'s entry-level plan?',
        a: 'Yes — geo-targeting precision is not gated behind higher-priced tiers; it\'s available on every plan, including Micro.',
      },
    ],
  },
  {
    slug: 'dataimpulse-alternative',
    title: 'DataImpulse Alternative: What to Weigh Beyond the Headline Per-GB Price',
    description:
      'DataImpulse is known for aggressive entry-level pay-as-you-go pricing. Here is what else to check before picking a provider on price alone.',
    excerpt:
      'The lowest per-GB number on a pricing page is not the whole story — geo-targeting depth, session support, and reseller options often decide the real total cost.',
    category: 'Comparisons',
    publishedAt: '2026-08-17',
    body: [
      {
        type: 'p',
        text: 'DataImpulse has positioned itself around low entry-level, pay-as-you-go pricing on residential bandwidth — a legitimate and appealing pitch for buyers whose main filter is per-GB cost. If price-per-GB in isolation is the only variable that matters to your use case, it deserves to be on your shortlist. Where it\'s worth looking past the headline number:',
      },
      { type: 'h2', text: 'What the per-GB number doesn\'t tell you' },
      {
        type: 'ul',
        items: [
          'Whether geo-targeting goes down to city level with real IP density, or stops at country/region',
          'Whether both rotating and sticky sessions are included, or one is a separate product',
          'What payment methods are supported — card-only vs. broader regional options',
          'Whether there\'s a documented path to reselling under your own brand, if that\'s relevant to how you plan to use the bandwidth',
        ],
      },
      { type: 'h2', text: 'How GlobProxy is positioned instead' },
      {
        type: 'p',
        text: "GlobProxy isn't chasing the absolute lowest advertised per-GB rate — it's priced competitively ($4.50 total to start, down to $2.00/GB at the 500 GB Scale tier) while keeping city-level targeting, both session types, and reseller access included at every tier rather than upsold separately. For workloads where geo-precision or session flexibility is actually part of the requirement, that bundling tends to matter more than shaving another few cents off the per-GB rate.",
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'Who should actually pick on price alone',
        text: 'If your task is high-volume, country-level-only, rotating-only scraping where geo-precision genuinely doesn\'t matter, the lowest per-GB rate on the market is a reasonable primary filter. Outside that specific case, it\'s worth checking what else is (or isn\'t) included at that price.',
      },
    ],
    faq: [
      {
        q: 'Is GlobProxy the cheapest residential proxy provider?',
        a: 'No — some providers advertise a lower headline per-GB rate at their lowest tier. GlobProxy is priced competitively while including city-level targeting, both session types, and reseller access at every tier rather than as paid add-ons.',
      },
      {
        q: 'What is the minimum purchase to try GlobProxy?',
        a: 'The Micro plan is 1 GB for $4.50 total, with no subscription or recurring commitment required.',
      },
    ],
  },
  {
    slug: 'proxy-pool-size-explained',
    title: 'What "35M+ IPs" Actually Means (And Why the Number Alone Doesn\'t Tell You Much)',
    description:
      'Every residential proxy provider advertises a large IP pool number. Here is what that figure actually measures, and the questions that matter more than the headline size.',
    excerpt:
      'A big pool number is easy to put on a homepage. Whether it\'s the right pool for your task depends on questions the number itself can\'t answer.',
    category: 'Bandwidth & Pricing',
    publishedAt: '2026-08-19',
    body: [
      {
        type: 'p',
        text: 'Every residential proxy provider leads with a pool-size number — tens of millions of IPs, dozens or hundreds of countries. It\'s an easy stat to headline and a genuinely reasonable first filter, but on its own it answers a narrower question than it seems to: it tells you how many IPs exist somewhere in the network, not how many are usable, fresh, or actually located where you need them.',
      },
      { type: 'h2', text: 'What the total pool number doesn\'t capture' },
      {
        type: 'ul',
        items: [
          "Distribution — a 35M-IP pool that's heavily concentrated in a handful of countries is a different product than one spread evenly across 195, depending on where your task actually needs coverage",
          'Freshness and rotation — a large pool with slow turnover behaves differently under load than a smaller pool that rotates cleanly',
          'City-level density within that pool — total country coverage and real city-level precision are separate claims, and a provider can have one without the other',
          'Real concurrent availability — the headline number is typically the full network size, not what\'s available to you specifically at a given moment under your plan',
        ],
      },
      { type: 'h2', text: 'Questions that actually predict whether a pool fits your task' },
      {
        type: 'ol',
        items: [
          'Does the country or city you need coverage in specifically have real density, not just a presence on the list?',
          'Does the provider support both rotating and sticky sessions from the same pool, or is that a separate tier?',
          'What happens under sustained, high-volume use — does performance hold, or does a large advertised pool mask thin coverage once real load hits it?',
          'Is the pool residential (real ISP-assigned addresses on real devices) or a mix that includes datacenter or lower-trust IPs bundled into the total count?',
        ],
      },
      {
        type: 'p',
        text: "GlobProxy's pool sits at 35M+ residential IPs across 195 countries with city-level structured targeting — that number is a starting filter, not the whole evaluation. The more useful question for any provider, this one included, is whether the specific coverage you need is actually dense where you need it.",
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'How to test this before committing to a plan',
        text: 'Start with the smallest available purchase (GlobProxy\'s Micro plan is $4.50 for 1 GB) and run your actual task against the specific city or country you care about, rather than evaluating a provider on the headline pool number alone.',
      },
    ],
    faq: [
      {
        q: 'Is a bigger IP pool always better?',
        a: 'Not in isolation — density in the specific location you need, freshness, and session support usually matter more for a given task than raw pool size on its own.',
      },
      {
        q: 'Are all of GlobProxy\'s 35M+ IPs residential?',
        a: 'Yes — the pool is residential IP addresses, distinct from datacenter proxy products.',
      },
    ],
  },
  {
    slug: 'proxy-pricing-real-cost-per-gb',
    title: 'The Real Cost-Per-GB Math: Subscription Proxies vs. Pay-Once Bandwidth',
    description:
      'Two plans can list similar per-GB rates and produce very different actual costs once usage variance and unused allowance are factored in. Here is the full math.',
    excerpt:
      'The number on the pricing page is the starting point, not the answer. Here is how to work out what a proxy plan actually costs given how you really use it.',
    category: 'Bandwidth & Pricing',
    publishedAt: '2026-08-20',
    body: [
      {
        type: 'p',
        text: "A per-GB rate on a pricing page is only half the input needed to know what a plan will actually cost you. The other half is your own usage pattern — specifically, how much it varies month to month — and that half is almost never on the pricing page at all.",
      },
      { type: 'h2', text: 'The two numbers that matter' },
      {
        type: 'ul',
        items: [
          'Advertised per-GB rate — what\'s printed on the pricing page, usually at a specific volume tier',
          'Effective per-GB rate — what you actually paid divided by what you actually used, once wasted allowance (subscription plans) or convenience premiums (very small pay-as-you-go purchases) are factored in',
        ],
      },
      {
        type: 'p',
        text: "These two numbers are only the same if your usage exactly matches the plan's assumptions every single billing period. For steady, predictable, flat usage, subscription plans can be genuinely competitive. For anything that varies — which is most real workloads — the effective rate on a monthly-reset plan tends to run higher than the advertised rate, because the advertised rate assumes full utilization every cycle.",
      },
      { type: 'h2', text: 'A worked example' },
      {
        type: 'p',
        text: "Take a 100 GB/month subscription at a given per-GB rate, and compare it to buying the same 100 GB as non-expiring bandwidth at a comparable rate. If actual usage is 100 GB every month without exception, the two are equivalent. If usage instead looks like 60 GB, 130 GB, 80 GB across three months — a common real-world pattern — the subscription plan wastes 40 GB in month one (unless it allows rollover, which most don't) and forces an overage purchase in month two, typically at a worse rate than the base plan. The non-expiring version simply draws down 60, then 130, then 80 from one running balance, at one consistent per-GB rate throughout.",
      },
      { type: 'h2', text: 'How to actually calculate this for your own workload' },
      {
        type: 'ol',
        items: [
          'Pull your last 3–6 months of actual GB usage, if you have it — from a current provider\'s dashboard, or a reasonable estimate if you\'re new to this',
          'Calculate the variance — how far the lightest month and heaviest month sit from the average',
          'If variance is low (usage is consistently close to flat), a well-priced subscription tier can be perfectly competitive',
          'If variance is meaningful, model the subscription cost including wasted allowance in light months and overage charges in heavy months, then compare that total to a non-expiring plan at a comparable per-GB rate',
        ],
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'The short version',
        text: 'Non-expiring bandwidth is not automatically cheaper — it removes the penalty for uneven usage. The more your workload varies month to month, the more that removal is worth in real terms.',
      },
    ],
    faq: [
      {
        q: 'Is non-expiring bandwidth always the cheaper option?',
        a: 'Not for perfectly flat, predictable usage — subscription plans can be competitive there. It becomes the cheaper option specifically as usage variance increases, because it removes the cost of wasted allowance and overage penalties.',
      },
      {
        q: 'Does GlobProxy charge more for smaller purchases?',
        a: 'The per-GB rate decreases at higher volume tiers (from $4.50/GB on Micro down to $2.00/GB on Scale), the same shape as most volume-based pricing — there is no separate penalty rate for pay-as-you-go purchases beyond that standard tier structure.',
      },
    ],
  },
  {
    slug: 'how-white-label-proxy-reselling-works',
    title: 'How White-Label Residential Proxy Reselling Actually Works',
    description:
      'A practical walkthrough of the white-label proxy reseller model: buying bandwidth stock, allocating it to your own clients, and setting your own pricing on top.',
    excerpt:
      'Reselling residential proxy bandwidth is simpler than it sounds structurally — the part that actually takes work is everything around the bandwidth itself.',
    category: 'Reseller',
    publishedAt: '2026-08-21',
    body: [
      {
        type: 'p',
        text: "White-label proxy reselling is structurally simple: you buy bandwidth in bulk at wholesale rates, allocate portions of it to your own clients under your own brand, and set whatever price you want on top. The underlying network — GlobProxy's, in this case — is invisible to your clients unless you choose to disclose it. What actually takes work isn't the bandwidth transaction itself; it's everything wrapped around it.",
      },
      { type: 'h2', text: 'The mechanics, concretely' },
      {
        type: 'ol',
        items: [
          "You buy bandwidth into your own account balance, same as any direct buyer — this becomes your \"stock\"",
          'You create a sub-user (proxy credential) for each client and allocate a specific GB amount to it from your stock',
          "That sub-user gets its own credentials, its own usage tracking, and its own IP whitelist — independent of your other clients' sub-users",
          "The client uses those credentials as their proxy endpoint; they never see GlobProxy's name unless you tell them",
          "You bill the client however you've structured your own pricing — GlobProxy doesn't set or take a cut of what you charge them",
        ],
      },
      { type: 'h2', text: "What's actually hard about it" },
      {
        type: 'p',
        text: "Provisioning a sub-user takes one API call. What takes real work is the same set of things that make any resale business work: pricing that leaves you margin without pricing yourself out of the market, keeping enough stock on hand that a client never hits a wall mid-task, and support — when a client's proxy stops working, they're coming to you, not to GlobProxy.",
      },
      {
        type: 'ul',
        items: [
          "Stock management — running out of allocatable bandwidth at the wrong moment is the reseller equivalent of a store running out of inventory during a rush",
          "Margin — your buy-in rate drops as your own volume tier increases, which is the actual lever for reseller profitability, not client count alone",
          "Client-facing reliability — auto-topup (covered in a separate guide) exists specifically so a client's allocation doesn't silently run dry without you or them noticing",
          'Support surface — you own the client relationship entirely, which is the tradeoff for owning the margin entirely',
        ],
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'On GlobProxy specifically',
        text: 'The reseller program includes a documented API for sub-user creation, top-up, auto-topup, and IP whitelisting, plus a dashboard (Earnings & Stock) that tracks your available balance and every client allocation\'s status. No separate reseller-tier plan required — reseller access is account-level.',
      },
    ],
    faq: [
      {
        q: 'Does GlobProxy take a cut of what I charge my clients?',
        a: 'No — you buy bandwidth at GlobProxy\'s standard tiered rates and set your own client pricing independently. There is no revenue-share or commission structure on top of that.',
      },
      {
        q: 'Can my clients tell they\'re running on GlobProxy\'s network?',
        a: 'Not unless you tell them — sub-user credentials are yours to brand and distribute however you choose.',
      },
    ],
  },
  {
    slug: 'reseller-api-automating-sub-user-provisioning',
    title: 'Automating Sub-User Provisioning With the GlobProxy Reseller API',
    description:
      'A walkthrough of the reseller API endpoints for creating, topping up, and managing client sub-users programmatically — for resellers who want this off their plate manually.',
    excerpt:
      'Once you\'re past a handful of clients, creating sub-users by hand in the dashboard stops scaling. Here is what automating it actually looks like.',
    category: 'Reseller',
    publishedAt: '2026-08-21',
    body: [
      {
        type: 'p',
        text: "Manually creating a sub-user in the dashboard for each new client works fine at small scale. It stops working the moment onboarding needs to happen without you personally clicking through a form — a self-serve signup flow on your own site, a batch of clients onboarded at once, or any workflow where sub-user creation needs to be a side effect of something else happening in your own system. That's what the reseller API is for.",
      },
      { type: 'h2', text: 'The core loop' },
      {
        type: 'ol',
        items: [
          'Create a sub-user with an initial GB allocation via `POST /api/v1/sub-users`',
          'Store the returned credentials against your own client record',
          'Track usage via `GET /api/v1/sub-users/:id/usage` — synced live from the upstream network while the credential is active',
          'Top up via `POST /api/v1/sub-users/:id/topup` when a client needs more, or turn on `PATCH /api/v1/sub-users/:id/auto-topup` so it happens without you in the loop at all',
          'Delete via `DELETE /api/v1/sub-users/:id` when a client churns — this releases whatever portion of the reservation was never used back to your available stock',
        ],
      },
      { type: 'h2', text: 'A minimal creation call' },
      {
        type: 'p',
        text: 'This is the same request the docs show — worth including here because it\'s genuinely the whole shape of it:',
      },
      {
        type: 'quote',
        text: 'curl -X POST https://globproxy.com/api/v1/sub-users -H "Authorization: Bearer YOUR_API_KEY" -d \'{"gb_allocated": 5}\'',
        cite: 'GlobProxy API docs — Create sub-user',
      },
      { type: 'h2', text: 'What to actually build around this' },
      {
        type: 'ul',
        items: [
          'A webhook or polling check on your side that reacts to a client hitting their allocation limit — the API tells you usage, but what you do when it\'s nearly exhausted is your own logic',
          'A mapping table between your own client IDs and GlobProxy sub-user IDs — the API doesn\'t know your client system, so this join lives entirely on your side',
          'Error handling for the specific status codes the docs call out — a 402 means your own stock is insufficient for the request, a 409 on whitelist endpoints means the sub-user is still provisioning, not a real conflict',
          'A deletion hook tied to your own client-churn event, so released bandwidth actually flows back to your available stock instead of sitting allocated to a dead account',
        ],
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'Full reference',
        text: 'This post covers the shape of it — the complete endpoint reference with every parameter and response field lives in the API docs.',
      },
    ],
    faq: [
      {
        q: 'Is there a limit to how many sub-users I can create?',
        a: 'The practical limit is your available bandwidth stock, not a hard cap on sub-user count — each creation call reserves GB from your account balance.',
      },
      {
        q: 'What happens to a sub-user\'s unused bandwidth if I delete it?',
        a: 'Whatever portion of the reservation was never used is released back to your own available stock.',
      },
    ],
  },
  {
    slug: 'reseller-auto-topup-client-bandwidth',
    title: 'Setting Up Auto-Topup So Client Bandwidth Never Silently Runs Out',
    description:
      'A client whose proxy stops working mid-task because their allocation ran dry is a support ticket you can prevent entirely. Here is how auto-topup on the reseller API works.',
    excerpt:
      'The worst version of this problem is finding out a client ran dry from an angry message, not from your own dashboard.',
    category: 'Reseller',
    publishedAt: '2026-08-21',
    body: [
      {
        type: 'p',
        text: "A client's sub-user running out of allocated bandwidth mid-task doesn't fail gracefully from their side — it just stops working, usually at the worst possible moment. As a reseller, the first sign of that is often a support message, not a dashboard alert you saw coming. Auto-topup exists specifically to remove that failure mode.",
      },
      { type: 'h2', text: 'How it works' },
      {
        type: 'p',
        text: 'Turning on auto-topup for a sub-user via `PATCH /api/v1/sub-users/:id/auto-topup` means that when the sub-user\'s remaining allocation drops to a threshold, additional bandwidth is drawn automatically from your own available stock and added to that sub-user\'s cap — no manual top-up call required, no window where the client\'s proxy is dead while you notice and react.',
      },
      { type: 'h2', text: 'What this trades off' },
      {
        type: 'ul',
        items: [
          'Auto-topup draws from your own stock, not the client\'s payment — if your billing arrangement with a client is prepaid-per-allocation, you need your own logic to reconcile "we auto-topped them up" against "did they actually pay for that yet"',
          'It prevents the outage failure mode but doesn\'t prevent overspend on your side if a client\'s usage spikes unexpectedly — worth pairing with your own usage alerting, not treating as a fully hands-off setting for every client',
          "For clients on a fixed monthly allocation you don't want silently exceeded, leaving auto-topup off and instead watching the usage endpoint is the more deliberate choice",
        ],
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'A reasonable default',
        text: 'Auto-topup on for clients you bill on ongoing/metered terms, where a live proxy matters more than a hard allocation ceiling. Off for clients on a fixed prepaid GB package, where you want to be the one deciding what happens when they hit the cap.',
      },
      { type: 'h2', text: 'The request' },
      {
        type: 'quote',
        text: 'curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID/auto-topup -H "Authorization: Bearer YOUR_API_KEY" -d \'{"enabled": true}\'',
        cite: 'GlobProxy API docs — Configure auto-topup',
      },
    ],
    faq: [
      {
        q: 'Does auto-topup have a maximum, or can it keep drawing from my stock indefinitely?',
        a: 'It draws from your available stock, which is itself finite — if your own balance runs out, auto-topup has nothing left to draw from, so it functions as bounded by your total stock, not unbounded.',
      },
      {
        q: 'Can I turn auto-topup on or off per client, or is it account-wide?',
        a: "It's configured per sub-user via the API, so you can set it differently for each client depending on how you've structured billing with them.",
      },
    ],
  },
  {
    slug: 'ip-whitelisting-client-proxy-credentials',
    title: 'IP Whitelisting for Client Proxy Credentials: A Practical Guide',
    description:
      'Restricting which IPs can use a sub-user\'s credentials is one of the simplest ways to prevent credential leakage from becoming someone else\'s free bandwidth. Here is how to set it up.',
    excerpt:
      'A leaked or shared credential without IP restriction is an open tap. Whitelisting is the cheapest fix available.',
    category: 'Reseller',
    publishedAt: '2026-08-21',
    body: [
      {
        type: 'p',
        text: 'Every sub-user credential you issue to a client is, by default, usable from anywhere by anyone who has it. That\'s fine until a credential leaks — checked into a public repo, pasted in the wrong Slack channel, reused by a client across more infrastructure than they told you about — at which point it\'s effectively free bandwidth for whoever has it, drawn from your stock. IP whitelisting is the direct fix: restrict a sub-user\'s credentials to only work from specific, known IP addresses.',
      },
      { type: 'h2', text: 'When this matters most' },
      {
        type: 'ul',
        items: [
          'Clients running from fixed infrastructure — a known server IP, a static office IP — where the legitimate usage source doesn\'t change',
          'High-allocation sub-users, where a leaked credential is a meaningfully larger loss than a small one',
          'Any client relationship where you want a clear, checkable record of exactly which IPs are authorized, rather than trusting the credential string alone as the only control',
        ],
      },
      { type: 'h2', text: 'When it\'s the wrong tool' },
      {
        type: 'p',
        text: "If a client's own usage pattern involves rotating source IPs on their end — running from cloud infrastructure that scales up and down, for instance — a tight whitelist becomes a maintenance burden that breaks their access every time their own IP changes. That's a case for relying on credential secrecy and rotation discipline instead of IP restriction, or for whitelisting a CIDR range if their infrastructure lives in one.",
      },
      { type: 'h2', text: 'The three calls' },
      {
        type: 'ul',
        items: [
          '`GET /api/v1/sub-users/:id/whitelist` — see what\'s currently authorized for a sub-user',
          '`POST /api/v1/sub-users/:id/whitelist` — add an IP',
          '`DELETE /api/v1/sub-users/:id/whitelist?ip=...` — remove one, e.g. when a client\'s infrastructure changes',
        ],
      },
      {
        type: 'callout',
        tone: 'accent2',
        title: 'Provisioning timing',
        text: 'Whitelist endpoints can return a 409 briefly right after a sub-user is first created — the credential is still provisioning upstream. This resolves on its own within moments; retry rather than treating it as a real conflict.',
      },
    ],
    faq: [
      {
        q: 'Is there a limit to how many IPs I can whitelist per sub-user?',
        a: 'The API doesn\'t document a hard cap in typical usage — for clients needing more than a handful of authorized IPs, a CIDR range is usually the more maintainable approach than listing each address individually.',
      },
      {
        q: 'Does whitelisting slow down provisioning a new sub-user?',
        a: 'No — whitelisting is a separate, optional step you take after creating the sub-user, not a required part of creation itself.',
      },
    ],
  },
  {
    slug: 'pricing-your-white-label-proxy-service',
    title: 'Pricing Your White-Label Proxy Service: What to Actually Charge',
    description:
      'There is no universal reseller markup that works for every client base. Here is a framework for setting your own pricing based on your buy-in rate, support overhead, and client segment.',
    excerpt:
      'The wrong question is "what markup do other resellers use." The right one is what your specific costs and client base actually support.',
    category: 'Reseller',
    publishedAt: '2026-08-21',
    body: [
      {
        type: 'p',
        text: "There's no single correct reseller markup — anyone offering one is glossing over the fact that it depends heavily on your buy-in rate at your volume tier, how much support and reliability you're actually providing on top of raw bandwidth, and what your specific client segment will bear. What follows is a framework for working it out for your own situation, not a number to copy.",
      },
      { type: 'h2', text: 'Start with your real buy-in rate, not the headline rate' },
      {
        type: 'p',
        text: 'GlobProxy\'s per-GB rate drops as your own purchase volume increases — from $4.50 at the smallest tier down to $2.00/GB at the 500 GB Scale tier. Your actual margin math should use whatever tier you\'re realistically buying at given your total client base, not the entry-level number, and should account for the fact that your effective rate improves as your reselling business grows — which is itself a reason to price competitively early and grow into the better tier, rather than pricing for margin you don\'t have yet.',
      },
      { type: 'h2', text: 'What you\'re actually charging for beyond the GB' },
      {
        type: 'ul',
        items: [
          'Convenience — a client who\'d rather pay you a flat monthly rate than deal with GB-based billing themselves',
          'Support — you\'re the one who answers when something breaks, which has real value even if the underlying network issue is out of your hands',
          'Bundling — if you\'re packaging proxy access alongside other services (scraping infrastructure, a SaaS product, managed automation), the proxy line item doesn\'t need to be priced in isolation',
          'Reliability — auto-topup and active stock management mean a client\'s access doesn\'t silently fail, which is worth something distinct from the bandwidth itself',
        ],
      },
      { type: 'h2', text: 'A simple way to sanity-check a price point' },
      {
        type: 'ol',
        items: [
          'Take your actual buy-in rate at your current volume tier',
          'Add your real support/overhead cost per client, even roughly — time spent isn\'t free even if it\'s not a line-item expense',
          'Set your client price meaningfully above that combined number, not just above the raw GB cost',
          'Check the result against what your specific client segment would realistically pay elsewhere — a freelance scraper and an agency buying for ten client accounts have very different price sensitivity',
        ],
      },
      {
        type: 'callout',
        tone: 'accent',
        title: 'The one number GlobProxy doesn\'t set',
        text: 'What you charge your clients is entirely yours to decide — there\'s no suggested retail price, no revenue share, and no restriction on how you package or bill it.',
      },
    ],
    faq: [
      {
        q: 'Does GlobProxy publish a recommended reseller markup?',
        a: 'No — pricing to your own clients is entirely up to you. This guide is a framework for working it out, not a fixed recommendation.',
      },
      {
        q: 'Does my buy-in rate improve automatically as I grow?',
        a: "Yes — GlobProxy's pricing is volume-tiered, so your effective per-GB cost drops as your total purchases increase, independent of any single client's allocation size.",
      },
    ],
  },
]
