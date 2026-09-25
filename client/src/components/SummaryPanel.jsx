import { useState } from 'react';
import { MAX_TRANSCRIPT_CHARS } from '../lib/limits.js';

export default function SummaryPanel({ onGenerate, summary, actionItems, engine }) {
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    try {
      await onGenerate(transcript);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="field">
        <label htmlFor="transcript">
          Paste notes or a transcript (leave blank to summarize the chat log instead)
        </label>
        <textarea
          id="transcript"
          rows={6}
          value={transcript}
          maxLength={MAX_TRANSCRIPT_CHARS}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste meeting notes, or dictate with your OS/browser speech-to-text…"
        />
        <div className="field-hint">
          {transcript.length.toLocaleString()} / {MAX_TRANSCRIPT_CHARS.toLocaleString()} characters
        </div>
      </div>
      <button
        className="btn btn-mint"
        onClick={handleGenerate}
        disabled={loading}
        style={{ width: '100%', marginBottom: 16 }}
      >
        {loading ? 'Generating…' : 'Generate summary + action items'}
      </button>

      {summary && (
        <div className="summary-block">
          <span className="label">Summary {engine ? `· ${engine}` : ''}</span>
          {summary}
        </div>
      )}

      {actionItems && actionItems.length > 0 && (
        <div>
          <span className="label" style={{ display: 'block', marginBottom: 6 }}>
            Action items
          </span>
          {actionItems.map((item, i) => (
            <div className="action-item" key={i}>
              <span className="assignee">{item.assignee}</span>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
