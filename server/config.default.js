/**
 * Redline configuration.
 *
 * This file is copied into your data directory the first time the server
 * starts, and read from there every time after. Edit the copy — not this one —
 * and restart the server for changes to take effect:
 *
 *     <data dir>/redline.config.js       (in Docker: /data/redline.config.js)
 *
 * Because it lives on the mounted volume, a Docker deployment can change these
 * without rebuilding the image. Anything you leave out falls back to the value
 * shown here, so it is safe to delete the parts you do not care about.
 */
export default {
  /**
   * How much of a committee has to be behind a working paper before it counts
   * as presentable — and before Redline will export it on the NMUN template.
   *
   * Counted as distinct delegations that are sponsors and/or signatories, over
   * the seat count set when the committee was created. A delegation holding
   * both roles counts once. 0.2 is one fifth, the usual NMUN rule; check your
   * conference's own rules of procedure, which sometimes differ by committee
   * size.
   */
  supportThreshold: 0.2,

  /**
   * Who may do what.
   *
   * Each entry is a list of who is allowed. The words you can use are:
   *
   *   'delegate'     a country's representative
   *   'faculty'      an accompanying teacher or advisor
   *   'secretariat'  the people running the event
   *   'admin'        anyone flagged as an administrator of this installation,
   *                  whatever their role (see `npm run admin`)
   *
   * An empty list [] means nobody, which is a perfectly good way to switch
   * something off.
   */
  permissions: {
    /**
     * Acting on the drafting floor: writing propositions and amendments,
     * asking to sponsor, declaring a text settled, signing, approving.
     *
     * Add 'faculty' here if you want advisors able to draft alongside their
     * delegation. Adding 'secretariat' is possible but rarely wise — the dais
     * writing the papers it will later judge is a conflict most conferences
     * avoid.
     */
    draft: ['delegate'],

    /**
     * Committee settings: its name, description, the seat count behind the
     * threshold, and the whitelist of countries allowed to sit.
     *
     * These change what every delegation sees and how eligibility is counted,
     * so they are kept to administrators by default.
     */
    editCommitteeSettings: ['admin'],

    /** Adding, renaming, reordering and removing agenda items. */
    editAgenda: ['admin', 'secretariat'],

    /**
     * Marking which agenda item the committee is debating right now. The dais
     * does this as the session runs, so the secretariat has it by default.
     */
    setCurrentTopic: ['admin', 'secretariat'],
  },

  /**
   * Contact details — email and phone — shown on a country's card and in the
   * committee's delegate list. Choose how far they travel:
   *
   *   'conference'  everyone signed in can see everyone's. Best for finding
   *                 the delegate you need to negotiate with, which is the
   *                 point of having them.
   *   'committee'   only delegations sitting on the same committee as you.
   *   'delegation'  only your own delegation's.
   *
   * The secretariat and administrators always see them, so somebody can reach
   * a participant in an emergency. Phone numbers are optional to give in any
   * case. If your conference has minors, consider 'committee'.
   */
  contacts: {
    visibility: 'conference',
  },

  /** Signing in. */
  password: {
    /**
     * Minimum length. Length is what protects a password; composition rules
     * ("one capital, one symbol") mostly produce worse ones that people write
     * down, so Redline does not impose any.
     */
    minLength: 10,

    /** Wrong guesses on one account before it is paused. */
    maxAttempts: 8,

    /** How long that pause lasts. */
    lockoutMinutes: 1,

    /** How long a reset code issued by an administrator stays usable. */
    resetValidMinutes: 60,
  },

  /**
   * The exported working paper. Redline fills the NMUN template: committee,
   * topic, sponsors and signatories in alphabetical order, then the text.
   */
  export: {
    /**
     * The line the paper opens with, under the header block. {committee} is
     * replaced with the committee's name.
     *
     * Committees are often listed in the Background Guide under a longer name
     * than the one you use day to day; if so, set the committee's name in its
     * settings to the full one, or write it in full here.
     */
    openingLine: 'The {committee},',

    /**
     * Keep the "Code:" line the Dais fills in. Leave true unless your
     * conference does not use it.
     */
    includeCodeLine: true,

    /**
     * Keep the template's affirmation that the text was written at the
     * conference and not copied in. It is the substantive part of the
     * template's instructions, and some conferences treat it as binding.
     */
    includeAffirmation: true,
  },
};
