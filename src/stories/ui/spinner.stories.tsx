import type { Meta, StoryObj } from '@storybook/nextjs';

import { Spinner } from '~/components/ui/spinner';

const meta = { title: 'ui/Spinner', component: Spinner } satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
