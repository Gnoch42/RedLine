import React from 'react';
import { CountrySelect } from './CountrySelect.jsx';

/**
 * A committee's roster rules. The list governs who may take a seat; shutting
 * observers out is a separate choice, because a closed roster and a closed door
 * are not the same thing.
 */
export function WhitelistEditor({
  enabled, onEnabled, blockObservers, onBlockObservers,
  list, onList, adding, onAdding, registered = [],
}) {
  const unlisted = registered.filter(
    (country) => !list.some((x) => x.toLowerCase() === country.toLowerCase())
  );

  return (
    <>
      <div className="field">
        <span className="label">Who may sit here</span>
        <label className="signature-check" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
          <span>
            Seat only the countries on a list. Others can still look in on the committee, but
            cannot register a delegation in it.
          </span>
        </label>
        {enabled && (
          <label className="signature-check">
            <input
              type="checkbox"
              checked={blockObservers}
              onChange={(e) => onBlockObservers(e.target.checked)}
            />
            <span>
              Close the door too: countries not on the list cannot even look in, their faculty
              included. The event secretariat is never shut out.
            </span>
          </label>
        )}
      </div>

      {enabled && (
        <div className="field">
          <span className="label">Countries seated here ({list.length})</span>
          <div className="chips">
            {list.map((country) => (
              <span className="chip" key={country}>
                {country}
                <button
                  type="button"
                  onClick={() => onList(list.filter((c) => c !== country))}
                  aria-label={`Remove ${country}`}
                >
                  ✕
                </button>
              </span>
            ))}
            {list.length === 0 && (
              <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                Nobody yet — an empty list leaves no country able to take a seat.
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>
              <CountrySelect value={adding} onChange={onAdding} taken={list} />
            </span>
            <button
              type="button"
              className="btn"
              disabled={!adding.trim()}
              onClick={() => { onList([...list, adding.trim()].sort()); onAdding(''); }}
            >
              Add
            </button>
          </div>

          {unlisted.length > 0 && (
            <>
              <div className="notice" style={{ margin: '10px 0' }}>
                {unlisted.join(', ')} {unlisted.length === 1 ? 'holds a seat' : 'hold seats'} here
                but {unlisted.length === 1 ? 'is' : 'are'} not on the list. A delegation already
                registered keeps its seat — the list governs who may still take one.
              </div>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => onList([...list, ...unlisted].sort())}
              >
                Add the {unlisted.length} already registered here
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
