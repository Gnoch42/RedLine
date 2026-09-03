import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A code to hand around, with the QR that carries the same thing — delegates
 * scan it on a phone instead of typing (§6).
 */
export function CodeCard({ code, what, link }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link || code, { margin: 1, width: 216, color: { dark: '#1c1a17', light: '#ffffff' } })
      .then((url) => { if (alive) setDataUrl(url); })
      .catch(() => { if (alive) setDataUrl(null); });
    return () => { alive = false; };
  }, [code, link]);

  return (
    <div className="codecard">
      {dataUrl && <img src={dataUrl} alt={`QR code for ${code}`} />}
      <div>
        <div className="codecard__code">{code}</div>
        <div className="codecard__what">{what}</div>
        <button
          type="button"
          className="btn btn--small"
          style={{ marginTop: 8 }}
          onClick={() => navigator.clipboard?.writeText(link || code)}
        >
          Copy {link ? 'link' : 'code'}
        </button>
      </div>
    </div>
  );
}
