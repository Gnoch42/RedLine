import React, { useMemo, useState } from 'react';
import { MEMBER_STATES, OBSERVERS, CUSTOM_OBSERVER } from '../lib/countries.js';

const KNOWN = new Set([...OBSERVERS, ...MEMBER_STATES]);

/**
 * Picking a country rather than typing one: no misspellings, no "Untied
 * Kingdom", and no way to file a delegation under a name nobody recognises.
 * Observers sit at the top, with a free-text option for the ones not listed.
 *
 * `taken` are countries already registered on the committee — shown, but not
 * selectable, so the clash is visible before the form is submitted.
 */
export function CountrySelect({ value, onChange, taken = [], autoFocus = false, id }) {
  const [custom, setCustom] = useState(() => !!value && !KNOWN.has(value));
  const takenSet = useMemo(
    () => new Set(taken.map((c) => c.toLowerCase())),
    [taken]
  );

  const option = (country) => (
    <option
      key={country}
      value={country}
      disabled={takenSet.has(country.toLowerCase())}
    >
      {country}{takenSet.has(country.toLowerCase()) ? ' — already registered' : ''}
    </option>
  );

  return (
    <>
      <select
        id={id}
        autoFocus={autoFocus}
        value={custom ? CUSTOM_OBSERVER : (value || '')}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_OBSERVER) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(next);
          }
        }}
      >
        <option value="" disabled>Select a country or observer…</option>
        <optgroup label="Observers">
          {OBSERVERS.map(option)}
          <option value={CUSTOM_OBSERVER}>Another observer…</option>
        </optgroup>
        <optgroup label="UN member states">
          {MEMBER_STATES.map(option)}
        </optgroup>
      </select>

      {custom && (
        <input
          style={{ marginTop: 6 }}
          value={value || ''}
          autoFocus
          maxLength={120}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Name of the observer delegation"
        />
      )}
    </>
  );
}
