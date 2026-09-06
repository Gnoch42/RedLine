import React from 'react';

/**
 * A slip in one corner of the interface should not take the committee's work
 * off the screen. React unmounts the whole tree on an uncaught render error, so
 * this catches it and offers the way back instead of a blank page.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Redline hit an error it could not render around:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="blank">
        <div className="blank__mark">✕</div>
        <h2>Something in the interface gave way</h2>
        <p>
          Nothing you have written is lost — everything lives on the server, and reloading
          should put you back where you were.
        </p>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
          {String(this.state.error?.message || this.state.error)}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try to carry on
          </button>
        </div>
      </div>
    );
  }
}
