export function LoadingState({ text = 'Carregando dados...' }: { text?: string }) {
  return <p className="loading-state">{text}</p>;
}
