import { describe, expect, it } from 'vitest';

import {
  BEX_CHAT_CONVERSATION_CREATED_EVENT,
  BEX_CHAT_CONVERSATION_DELETED_EVENT,
  BEX_CHAT_CONVERSATION_EXPORTED_EVENT,
  BEX_CHAT_FEEDBACK_SUBMITTED_EVENT,
  BEX_CHAT_MESSAGE_SENT_EVENT,
  buildBexChatConversationCreatedEvent,
  buildBexChatConversationDeletedEvent,
  buildBexChatConversationExportedEvent,
  buildBexChatFeedbackSubmittedEvent,
  buildBexChatMessageSentEvent,
} from '~/lib/event-logging/bex-events';

describe('buildBexChatMessageSentEvent', () => {
  it('builds the event with conversation, prompt length, model, mode, and validator flag', () => {
    const { event, meta } = buildBexChatMessageSentEvent({
      conversationId: 'conv-1',
      promptLength: 42,
      model: 'gpt-4o-mini',
      agentMode: 'orchestrator',
      useValidator: false,
    });
    expect(event).toBe(BEX_CHAT_MESSAGE_SENT_EVENT);
    expect(meta).toEqual({
      conversationId: 'conv-1',
      promptLength: 42,
      model: 'gpt-4o-mini',
      agentMode: 'orchestrator',
      useValidator: false,
    });
  });

  it('coerces an invalid prompt length to a safe integer', () => {
    const { meta } = buildBexChatMessageSentEvent({
      conversationId: 'conv-1',
      promptLength: Number.NaN,
      model: 'gpt-4o-mini',
      agentMode: 'dilution',
      useValidator: true,
    });
    expect(meta.promptLength).toBe(0);
  });

  it('truncates a fractional prompt length and clamps a negative one', () => {
    expect(
      buildBexChatMessageSentEvent({
        conversationId: 'c',
        promptLength: 12.9,
        model: 'm',
        agentMode: 'product',
        useValidator: false,
      }).meta.promptLength,
    ).toBe(12);
    expect(
      buildBexChatMessageSentEvent({
        conversationId: 'c',
        promptLength: -3,
        model: 'm',
        agentMode: 'product',
        useValidator: false,
      }).meta.promptLength,
    ).toBe(0);
  });

  it('never includes the prompt text (privacy contract)', () => {
    const prompt = 'What is the dilution ratio for pH7Q?';
    const { meta } = buildBexChatMessageSentEvent({
      conversationId: 'conv-1',
      promptLength: prompt.length,
      model: 'gpt-4o-mini',
      agentMode: 'bathroom',
      useValidator: false,
    });
    expect(Object.keys(meta)).not.toContain('prompt');
    expect(Object.keys(meta)).not.toContain('message');
    expect(JSON.stringify(meta)).not.toContain('pH7Q');
    expect(meta.promptLength).toBe(prompt.length);
  });

  it('merges extra context without letting it override the core fields', () => {
    const { meta } = buildBexChatMessageSentEvent({
      conversationId: 'conv-1',
      promptLength: 10,
      model: 'gpt-4o-mini',
      agentMode: 'floor_vct',
      useValidator: true,
      extra: { surface: 'bex-composer', model: 'spoofed' },
    });
    expect(meta.surface).toBe('bex-composer');
    expect(meta.model).toBe('gpt-4o-mini');
  });
});

describe('conversation lifecycle events', () => {
  it('builds the created event', () => {
    expect(buildBexChatConversationCreatedEvent({ conversationId: 'conv-1' })).toEqual({
      event: BEX_CHAT_CONVERSATION_CREATED_EVENT,
      meta: { conversationId: 'conv-1' },
    });
  });

  it('builds the deleted event', () => {
    expect(buildBexChatConversationDeletedEvent({ conversationId: 'conv-2' })).toEqual({
      event: BEX_CHAT_CONVERSATION_DELETED_EVENT,
      meta: { conversationId: 'conv-2' },
    });
  });

  it('builds the exported event with the target format', () => {
    expect(
      buildBexChatConversationExportedEvent({
        conversationId: 'conv-3',
        format: 'markdown',
      }),
    ).toEqual({
      event: BEX_CHAT_CONVERSATION_EXPORTED_EVENT,
      meta: { conversationId: 'conv-3', format: 'markdown' },
    });
  });

  it('never includes conversation content on the exported event', () => {
    const { meta } = buildBexChatConversationExportedEvent({
      conversationId: 'conv-3',
      format: 'json',
    });
    expect(Object.keys(meta)).not.toContain('content');
    expect(Object.keys(meta)).not.toContain('messages');
  });
});

describe('buildBexChatFeedbackSubmittedEvent', () => {
  it('builds the event with conversation, message, and rating', () => {
    const { event, meta } = buildBexChatFeedbackSubmittedEvent({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      rating: 'up',
    });
    expect(event).toBe(BEX_CHAT_FEEDBACK_SUBMITTED_EVENT);
    expect(meta).toEqual({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      rating: 'up',
    });
  });

  it('includes reasonCode when present', () => {
    const { meta } = buildBexChatFeedbackSubmittedEvent({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      rating: 'down',
      reasonCode: 'wrong_dilution',
    });
    expect(meta.reasonCode).toBe('wrong_dilution');
  });

  it('omits reasonCode entirely when null, undefined, or blank', () => {
    for (const reasonCode of [null, undefined, '']) {
      const { meta } = buildBexChatFeedbackSubmittedEvent({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        rating: 'down',
        reasonCode,
      });
      expect(Object.keys(meta)).not.toContain('reasonCode');
    }
  });

  it('never includes the free-text feedback comment (privacy contract)', () => {
    const { meta } = buildBexChatFeedbackSubmittedEvent({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      rating: 'down',
      reasonCode: 'missing_source',
    });
    expect(Object.keys(meta)).not.toContain('comment');
    expect(Object.keys(meta)).not.toContain('feedbackText');
  });
});
