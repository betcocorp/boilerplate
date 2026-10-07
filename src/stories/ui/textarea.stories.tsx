import type { Meta, StoryObj } from '@storybook/nextjs';

import { Textarea } from '~/components/ui/textarea';

const meta = {
  title: 'ui/Textarea',
  component: Textarea,
  args: { placeholder: 'Write something…' },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
