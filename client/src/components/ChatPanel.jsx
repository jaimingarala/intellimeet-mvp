import { useEffect, useRef, useState } from 'react';

export default function ChatPanel({ messages, onSend, currentUserName }) {
  const [text, setText] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  }

  return (
    <>
      <div className="chat-messages">
        {messages.length === 0 && <div className="empty-state">No messages yet.</div>}
        {messages.map((m, i) => (
          <div className="chat-message" key={i}>
            <div className="sender">{m.senderName === currentUserName ? 'You' : m.senderName}</div>
            <div className="text">{m.text}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          placeholder="Message the room…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-secondary" type="submit">
          Send
        </button>
      </form>
    </>
  );
}
