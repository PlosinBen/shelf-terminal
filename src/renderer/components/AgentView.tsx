import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentProvider } from '@shared/types';

interface AgentMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  toolName?: string;
  timestamp: number;
}

interface Props {
  tabId: string;
  cwd: string;
  connection: import('@shared/types').Connection;
  provider: AgentProvider;
}

export function AgentView({ tabId, cwd, connection, provider }: Props) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    window.shelfApi.agent.init(tabId, cwd, connection, provider);
  }, [tabId, cwd, connection, provider]);

  useEffect(() => {
    const offMessage = window.shelfApi.agent.onMessage((id, msg: any) => {
      if (id !== tabId) return;
      if (msg.type === 'error') {
        setMessages((prev) => [...prev, {
          id: `err-${Date.now()}`,
          type: 'error',
          content: msg.content,
          timestamp: Date.now(),
        }]);
        return;
      }
      setMessages((prev) => [...prev, {
        id: `msg-${Date.now()}-${Math.random()}`,
        type: msg.type === 'tool_use' ? 'tool_use' : msg.type === 'tool_result' ? 'tool_result' : msg.type === 'text' ? 'assistant' : 'system',
        content: msg.content,
        toolName: msg.toolName,
        timestamp: Date.now(),
      }]);
    });

    const offStream = window.shelfApi.agent.onStream((id, chunk: any) => {
      if (id !== tabId) return;
      setStreamText((prev) => prev + (chunk.content ?? ''));
    });

    const offStatus = window.shelfApi.agent.onStatus((id, status: any) => {
      if (id !== tabId) return;
      const wasStreaming = isStreaming;
      const nowStreaming = status.state === 'streaming';
      setIsStreaming(nowStreaming);
      if (wasStreaming && !nowStreaming) {
        setStreamText((prev) => {
          if (prev.trim()) {
            setMessages((msgs) => [...msgs, {
              id: `stream-${Date.now()}`,
              type: 'assistant',
              content: prev,
              timestamp: Date.now(),
            }]);
          }
          return '';
        });
      }
    });

    return () => { offMessage(); offStream(); offStatus(); };
  }, [tabId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamText]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setMessages((prev) => [...prev, {
      id: `user-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: Date.now(),
    }]);
    setInput('');
    setStreamText('');
    window.shelfApi.agent.send(tabId, text);
  }, [tabId, input, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = () => {
    window.shelfApi.agent.stop(tabId);
  };

  return (
    <div className="agent-view">
      <div className="agent-messages" ref={listRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`agent-msg agent-msg-${msg.type}`}>
            <div className="agent-msg-role">
              {msg.type === 'user' ? 'You' :
               msg.type === 'assistant' ? provider :
               msg.type === 'tool_use' ? `tool: ${msg.toolName}` :
               msg.type === 'tool_result' ? 'result' :
               msg.type === 'error' ? 'error' : 'system'}
            </div>
            <div className="agent-msg-content">{msg.content}</div>
          </div>
        ))}
        {streamText && (
          <div className="agent-msg agent-msg-assistant">
            <div className="agent-msg-role">{provider}</div>
            <div className="agent-msg-content">{streamText}<span className="agent-cursor" /></div>
          </div>
        )}
      </div>
      <div className="agent-input-bar">
        <textarea
          ref={inputRef}
          className="agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${provider}...`}
          rows={1}
        />
        {isStreaming ? (
          <button className="agent-stop-btn" onClick={handleStop}>Stop</button>
        ) : (
          <button className="agent-send-btn" onClick={handleSend} disabled={!input.trim()}>Send</button>
        )}
      </div>
    </div>
  );
}
