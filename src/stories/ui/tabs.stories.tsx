import type { Meta, StoryObj } from '@storybook/nextjs';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';

const meta = { title: 'ui/Tabs', component: Tabs } satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs className="w-96" defaultValue="one">
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First panel.</TabsContent>
      <TabsContent value="two">Second panel.</TabsContent>
    </Tabs>
  ),
};
