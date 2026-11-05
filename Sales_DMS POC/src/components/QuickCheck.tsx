import { useState, type FormEvent } from 'react';
import type { ChatContext } from '../types';

interface Props {
  initial: ChatContext;
  disabled: boolean;
  onSubmit: (prompt: string) => void;
}

/** Structured entry for planners who prefer a form; it becomes a normal chat question so the thread stays complete. */
export default function QuickCheck({ initial, disabled, onSubmit }: Props) {
  const [material, setMaterial] = useState(initial.material ?? '');
  const [plant, setPlant] = useState(initial.plant ?? '');
  const [quantity, setQuantity] = useState(initial.quantity ? String(initial.quantity) : '');
  const [unit, setUnit] = useState(initial.unit ?? 'EA');
  const [date, setDate] = useState(initial.requestedDate ?? '');

  const valid = material.trim() && plant.trim() && Number(quantity) > 0 && date;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit(`Check material ${material.trim()} at plant ${plant.trim()}, ${Number(quantity)} ${unit.trim() || 'EA'}, requested date ${date}.`);
  };

  return (
    <form className="quick" onSubmit={submit}>
      <label>
        Material
        <input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="e.g. 1000001" />
      </label>
      <label className="narrow">
        Plant / DC
        <input value={plant} onChange={(e) => setPlant(e.target.value.toUpperCase())} maxLength={4} placeholder="1000" />
      </label>
      <label className="narrow">
        Quantity
        <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" placeholder="50" />
      </label>
      <label className="narrow">
        Unit
        <input value={unit} onChange={(e) => setUnit(e.target.value.toUpperCase())} maxLength={3} />
      </label>
      <label>
        Requested date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <button className="btn" type="submit" disabled={disabled || !valid}>
        Check
      </button>
    </form>
  );
}
