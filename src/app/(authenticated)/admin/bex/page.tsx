import { BexChatApp } from '~/components/bex/BexChatApp';

export const metadata = {
  title: 'BEX Chat | Betco BEX',
  description: 'Conversational assistant workspace for Betco BEX.',
};

// B0-68 — no settings read here any more: streaming and the AI Elements renderer are both
// unconditional, so `NEXT_PUBLIC_BEX_AI_ELEMENTS_UI` / `NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT`
// are retired and this page has nothing left to resolve server-side for the chat app.
export default function AdminBexPage() {
  return <BexChatApp />;
}
