'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from '~/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '~/components/ai-elements/message';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

/**
 * Minimal example wiring `useChat` (`@ai-sdk/react`) to `POST /api/chat` (`~/app/api/chat/route.ts`)
 * with the kept `ai-elements` rendering components. Not production chat UI — a starting point.
 */
export default function ChatExample() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border">
      <Conversation>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState description="Ask anything to start the conversation." />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) =>
                    part.type === 'text' ? (
                      <MessageResponse key={index}>{part.text}</MessageResponse>
                    ) : null,
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
      </Conversation>
      <form className="flex gap-2 border-t p-3" onSubmit={handleSubmit}>
        <Input
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message…"
          value={input}
        />
        <Button disabled={status === 'streaming'} type="submit">
          Send
        </Button>
      </form>
    </div>
  );
}
