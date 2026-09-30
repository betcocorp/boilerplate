import ChatExample from '~/components/ChatExample';

export default function DashboardPage() {
  return (
    <div className="mx-auto flex h-screen w-full max-w-2xl flex-col p-4">
      <h1 className="mb-4 text-lg font-semibold">AI SDK chat example</h1>
      <ChatExample />
    </div>
  );
}
