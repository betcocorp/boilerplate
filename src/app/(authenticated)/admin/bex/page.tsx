import { BexChatApp } from '~/components/bex/BexChatApp';
import { getBooleanSetting, getStringSetting } from '~/lib/settings/settings-service';

export const metadata = {
  title: 'BEX Chat | Betco BEX',
  description: 'Conversational assistant workspace for Betco BEX.',
};

export default async function AdminBexPage() {
  const [useAiElements, streamingRolloutCohort] = await Promise.all([
    getBooleanSetting('NEXT_PUBLIC_BEX_AI_ELEMENTS_UI', false),
    getStringSetting('NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT', 'default'),
  ]);
  return <BexChatApp settings={{ useAiElements, streamingRolloutCohort }} />;
}
