import React, { useEffect, useState } from 'react';
import io from 'socket.io-client';

const socket = io(); // connects to same host (or set explicit URL)

function App() {
  const [coaching, setCoaching] = useState({
    concern: '',
    response_tip: '',
    next_line: '',
    warning: '',
    talk_ratio: ''
  });

  useEffect(() => {
    socket.on('coaching_update', (data) => {
      setCoaching({
        concern: data.concern || '',
        response_tip: data.response_tip || '',
        next_line: data.next_line || '',
        warning: data.warning || '',
        talk_ratio: data.talk_ratio || ''
      });
    });

    return () => socket.off('coaching_update');
  }, []);

  return (
    <div style={{ fontFamily: 'Arial', padding: '20px', maxWidth: '400px' }}>
      <h2>🤖 Live Coach</h2>
      <div style={{ marginBottom: '15px' }}>
        <strong>Prospect Concern:</strong>
        <div>{coaching.concern}</div>
      </div>
      <div style={{ marginBottom: '15px' }}>
        <strong>What to say next:</strong>
        <div style={{ background: '#f0f0f0', padding: '10px', borderRadius: '8px' }}>
          {coaching.next_line}
        </div>
      </div>
      <div style={{ marginBottom: '15px' }}>
        <strong>Tip:</strong> {coaching.response_tip}
      </div>
      {coaching.warning && coaching.warning !== 'none' && (
        <div style={{ color: 'red', marginBottom: '15px' }}>
          <strong>Warning:</strong> {coaching.warning}
        </div>
      )}
      <div>
        <strong>Talk ratio:</strong> {coaching.talk_ratio}
      </div>
    </div>
  );
}

export default App;