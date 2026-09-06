# Redline

A self-hosted drafting floor for Model UN. It replaces the shared Word document a
committee would otherwise fight over: every change to a proposal has an author and a
timestamp, rival drafts sit side by side, and the text only moves when the sponsors of a
proposition all say so.

Formal adoption still happens in the room. Redline stops at *eligible to be presented*.

---

## Running it

**Docker (what you want for an actual simulation)**

```bash
docker compose up --build
```

Then open <http://localhost:3000>. One service, one port; the database is a single SQLite
file on the `redline-data` volume, so restarts keep the committee's work. Change the port
with `REDLINE_PORT=8080 docker compose up`.

**Locally, without Docker** — needs Node 22.13 or newer (the database driver is Node's
built-in `node:sqlite`, so there is nothing to compile):

```bash
npm install
npm run build
npm start
```

**While developing** — API on :3000, Vite with hot reload on :5173 (it proxies `/api`):

```bash
npm install && npm --prefix client install
npm run dev
```

**Tests** — the business rules in §5 of the spec, end to end over HTTP:

```bash
npm test
```

**A worked example to click around in**, with a committee, six delegations, an adopted
amendment and a frozen one. It talks to a **server that is already running** — it does
not start one, so leave `npm start` going in another terminal first:

```bash
npm run seed
```

It prints an email and join code for each delegation to sign in with. If the server is
somewhere other than `http://localhost:3000`, tell it where:

```bash
REDLINE_URL=http://localhost:8080 npm run seed
```

---

## How a simulation gets set up

An account is a **person**: a name, an email, an optional phone or WhatsApp number, and
what they are at the conference.

- **Delegate** — represents a country. The country is chosen from a list (the 193 UN member
  states, with observers grouped at the top and a free-text option for any observer not
  listed), never typed, so no delegation ends up filed under a misspelling. It carries over
  as the default every time they register a delegation, and can still be overridden: one
  account holds as many seats as you like, which is the usual case when the same delegate
  sits on several committees.
- **Faculty** — an accompanying teacher or advisor. They sit with their delegation, using
  its join code, and have the same hands as its delegates.
- **Secretariat** — the people running the event. They pick no country, hold no delegation,
  and can open any committee to read it. They propose nothing, sponsor nothing and approve
  nothing, and they never occupy one of the committee's seats, so they cannot move the 20%
  threshold. Having no delegation whose code they could share, they get a personal sign-in
  code of their own.

1. One person **creates the committee**: its name, how many countries are seated in it,
   and the agenda items.
2. Everyone else **picks it from the list** of committees, which every signed-in delegate
   sees. Joining is one click: the country comes from the account, and the ones already
   spoken for on that committee are shown but cannot be picked, so a clash is visible
   before anything is submitted. Nothing has to be handed out for this to work.
3. The **delegation join code** goes to a delegation's own delegates and its faculty. It
   is both the invitation and the password: signing in is an email plus that code, and it
   can be copied or scanned as a QR.

A committee still has a code of its own, and `POST /api/teams` still accepts it, but the
interface no longer asks anyone for it — the list is the way in.

Everyone seated on a committee can correct its settings afterwards — its name, its
description, the seat count behind the 20% threshold, and the agenda itself — and your own
name and country under Committee → Delegations. There is no organiser account and no
moderator; nothing in the app requires elevated privileges, by design.

## The rules the app enforces

### How a proposition travels

```
draft ──submit──> open ──every sponsor calls it settled──> signing ──20%──> ready
                   ▲                                          │              │
                   └──────── any sponsor takes that back ──────┴──────────────┘
```

- **A proposition belongs to its sponsors, jointly and equally.** Writing one makes you its
  first sponsor, not its owner: there is no instigator and no privileged author.
- **Sponsorship is by admission.** A delegation asks to sponsor — with a note, if it wants
  to make its case — and a delegation already sponsoring admits or declines it. Nobody
  joins unilaterally.
- **No sponsor can withdraw a proposition over the others' heads.** A sponsor who no longer
  supports it stands down; the last one left, with nobody else behind the text, can
  withdraw it.
- **Drafts belong to the sponsors** — at that stage, to the one delegation that wrote it.
  Every delegate of that country can read and revise them; the rest of the committee cannot
  see them at all.
- **Versions are immutable.** Each one records its author and its parent, so the whole
  history can be walked backwards and any two versions compared.
- **A live proposition's text cannot be edited directly** — only a private draft can. Once
  it is submitted, the text moves only by amendment.
- **An amendment needs every current sponsor of the target proposition**, tracked
  individually so the UI can show "3/5 sponsors approved". The amendment's own co-sponsors
  are its authors and carry no approval weight. On the last approval a new version is
  generated automatically and the amendment is marked adopted.
- **Conflicting amendments freeze rather than merge.** When one amendment is adopted, every
  other pending amendment written against the version it superseded is frozen and flagged.
  Its authors reapply it to the current version by hand; prior approvals are cleared,
  because sponsors approved a different text.
- **Detaching** takes an amendment out of the proposition and files it as a standalone
  proposition of its own, seeded at version 1 and sponsored by the delegation that wrote it.
- **The sponsors close the text together.** Each declares it settled — *ready to collect
  signatories* — which is only offered while no amendment is still in front of them. When
  the last one does, the proposition moves to **signing**. Any sponsor taking that back
  reopens it to amendment, and so does an amendment being submitted or adopted: nobody's
  declaration survives the text moving.
- **Signing is a commitment, and is asked for as one.** A delegation is shown the text as it
  stands and must undertake, explicitly, to sign it as it stands before the signature is
  recorded — against that version, so a signature given on an earlier draft is visibly
  marked as such. Sponsors carry a proposition rather than sign it.
- **20% to present.** Distinct delegations backing a proposition as sponsor and/or signatory,
  over the seat count fixed when the committee was created. Crossing it turns **signing**
  into **ready**; signatories keep being added afterwards.

## Finding people

Any country name in the interface — on a card, in a sponsor list, beside an amendment —
opens that country's card: who speaks for it on each committee, with their role, email and
phone, and what that delegation has put on the table there. Contact details are shared
across the whole conference on purpose: finding the delegate you need to negotiate with is
the point of it. Leave the phone field empty to keep that one to yourself.

## What the interface looks like

Three panels: the committee's agenda and its propositions on the left, the document in
the middle, the amendments to the open proposition on the right. Opening an amendment
splits the middle in two — the version it answers beside the redline — and the ✕ in its
corner closes it again, leaving the proposition on its own.

Diffs are computed in the browser over the Markdown source and shown the way a redlined
draft reads — struck text and inserted text in place. Every redline has a **Clean**
toggle beside it for reading the proposed text as it would stand. Views refresh by
polling every few seconds (every 30s when the tab is in the background).

---

## Decisions worth knowing about

Places where the build spec was silent, or where the implementation makes a call:

- **Committees are listed, not looked up by code.** The spec described joining a
  delegation but not how a second country reaches a committee someone else created. A code
  answered that first; a visible directory answers it better, and with the country already
  on the account there is then nothing left to type. It does mean every signed-in delegate
  sees every committee on the instance — which is right for a self-hosted tool running one
  conference, with no moderator and nothing to keep from the people taking part.
- **An account is identified by email, not by a `country-committee` username.** The spec's
  username assumed one delegate per country per committee and one committee per delegate;
  both are wrong in practice. Email is unique, memorable, and survives a delegate moving
  between delegations.
- **A valid join code seats you in that delegation.** Login is per delegation, so
  presenting a delegation's code is what proves you belong to it. A delegate keeps every
  seat they have been given and moves between them from the masthead. There are still no
  per-delegate passwords (spec §6, deliberately deferred) — which does mean anyone holding
  a delegation's code and a delegate's email can sign in as them.
- **Propositions and amendments have a title and no description.** A title that says what
  the text does carries the explorer card on its own; a second summary field was one more
  thing to write and to keep true.
- **Countries are picked from a list, never typed**, and the list is a plain file —
  `client/src/lib/countries.js`. A conference that uses the long UN protocol forms, or that
  seats observers of its own, edits that one file. The server stores whatever is chosen as
  free text, so the list is a guardrail in the interface rather than a rule the data
  enforces.
- **The account's country is a default, not a constraint.** A delegate who speaks for
  someone else on another committee changes it there, and the seats they already hold are
  untouched.
- **Faculty have the same hands as delegates.** They sit inside a delegation, see its
  private drafts, and can sponsor and approve on its behalf. That is a choice, not a
  finding: restricting them to reading would be a one-line change to `requireDelegation`.
- **The secretariat can still edit committee settings and the agenda.** Setting up the room
  is administration, not drafting, and every delegate can do it too — there is no
  moderator. What they cannot do is put text on the table or support it.
- **The secretariat sees every committee, and everyone's contact details are visible to
  everyone.** Both follow from what the tool is for. A conference that needs either of them
  narrowed should say so before using this with minors' phone numbers in it.
- **`total_members` lives only on the committee.** The spec listed it on both `Team` and
  `Committee`; storing the same number twice only invites drift.
- **Draft privacy is per user, so propositions and amendments carry an author user**
  alongside their author delegation.
- **Sponsorship is adjudicated by the sponsors, not by a moderator.** The spec says a
  sponsor is a delegation that contributed content; with nobody above the committee to rule
  on that, the people already carrying the text decide who joins them. Standing down is
  re-checked against pending amendments, since a smaller sponsor set can complete an
  approval that was waiting on you.
- **Signatures are only collected on a closed text.** Undertaking to sign something that
  can still be amended underneath you is not an undertaking, so signing opens only once the
  sponsors have declared the text settled. During negotiation, support is the sponsors.
- **A sponsor cannot also sign.** They already carry the text; counting them twice would
  say nothing.
- **Readiness is blocked by pending amendments only, not frozen ones.** A frozen amendment
  needs its author to act, and should not be able to hold a proposition hostage.
- **An amendment to a proposition with no sponsors cannot be approved.** "Every sponsor has
  approved" is vacuously true when there are none. Since writing a proposition now makes you
  its sponsor, this should be unreachable — the guard stays anyway.
- **A draft amendment whose base has moved on is frozen when submitted**, rather than
  rejected — same state and same fix as a conflict discovered later.
- **Diffs are over the Markdown source**, not rendered HTML. It is what a redline
  actually is, and it stays honest about whitespace and structure; the Clean toggle
  covers readability.

## Out of scope for v1

No moderator role, no in-app adoption vote, no export to an official template, English
only, no per-delegate passwords.

---

## Layout

```
server/           Express API. routes/ is thin; model.js holds the rules above.
  schema.sql      The whole database, applied at boot.
  db.js           Opens it, and migrates one written by an earlier build.
client/src/       React app. components/ is the three-panel UI, lib/ the diff,
                  Markdown rendering, polling helpers and the country list.
test/             HTTP-level tests of the business rules.
scripts/seed.js   The worked example.
```

### API

```
POST   /api/auth/register              { delegate_name, email, phone, role, country }
POST   /api/auth/login                 { email, join_code }   -> seats you in that delegation
                                       (the secretariat presents its own personal code)
POST   /api/auth/logout
GET    /api/auth/me                    the person, their seats, the active one
PATCH  /api/auth/me                    { delegate_name, phone, country }
POST   /api/auth/switch                { team_id } — or { committee_id } for the secretariat

GET    /api/committees                 every committee, with seats taken and your own
GET    /api/countries/:name            who speaks for a country, on every committee
POST   /api/committees                 create a committee and its first delegation
PATCH  /api/committees/:id             { name, description, total_members }
POST   /api/teams                      { committee_id | committee_code, country_name }
POST   /api/teams/join                 { join_code }
GET    /api/committees/:id             delegations, delegates, codes
GET    /api/committees/:id/board       agenda + propositions, in one poll
GET    /api/committees/:id/projects
POST   /api/committees/:id/projects    { name }
PATCH  /api/projects/:id               { name, position }  rename / reorder
DELETE /api/projects/:id               only while it holds no propositions

GET    /api/projects/:id/propositions
POST   /api/projects/:id/propositions  { name, content }  -> draft + v1, you as first sponsor
GET    /api/propositions/:id
PATCH  /api/propositions/:id           retitle a draft
POST   /api/propositions/:id/versions  { content, note }   drafts only
PATCH  /api/propositions/:id/submit    draft -> open
POST   /api/propositions/:id/withdraw  last remaining sponsor only

POST   /api/propositions/:id/sponsor-request           { message }  ask to be admitted
DELETE /api/propositions/:id/sponsor-request           take the request back
POST   /api/propositions/:id/sponsor-requests/:rid/accept   a sponsor lets them in
POST   /api/propositions/:id/sponsor-requests/:rid/decline
DELETE /api/propositions/:id/support/sponsor           stand down
POST   /api/propositions/:id/ready     this sponsor calls the text settled
DELETE /api/propositions/:id/ready     take that back, reopening it to amendment
POST   /api/propositions/:id/sign      { undertaking: true }  signing / ready only
DELETE /api/propositions/:id/support/signatory
GET    /api/propositions/:id/versions
GET    /api/propositions/:id/versions/:versionId
GET    /api/propositions/:id/versions/diff?from=&to=

GET    /api/propositions/:id/amendments
POST   /api/propositions/:id/amendments { name, content, cosponsor_team_ids }
GET    /api/amendments/:id
PATCH  /api/amendments/:id             edit a draft
PATCH  /api/amendments/:id/submit      draft -> pending (or frozen, if stale)
POST   /api/amendments/:id/approve     one sponsor's approval; adopts on the last one
POST   /api/amendments/:id/detach      -> a standalone proposition
POST   /api/amendments/:id/reapply     { content }  rebase a frozen amendment
POST   /api/amendments/:id/withdraw
```

Authentication is a bearer token from register/login, sent as `Authorization: Bearer …`.
