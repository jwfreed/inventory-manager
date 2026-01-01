import { useState } from 'react';
import { useCreateUomConversion, useDeleteUomConversion } from '../api/uomConversions';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Inputs';
import { Alert } from '../../../components/Alert';
import type { Item, UomConversion } from '../../../api/types';

type Props = {
  item: Item;
  conversions: UomConversion[];
};

export function UomConversionsCard({ item, conversions }: Props) {
  const [fromUom, setFromUom] = useState('');
  const [toUom, setToUom] = useState('');
  const [factor, setFactor] = useState(1);

  const createMutation = useCreateUomConversion();
  const deleteMutation = useDeleteUomConversion();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      itemId: item.id,
      fromUom,
      toUom,
      factor,
    });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">UoM Conversions</h3>
      {createMutation.isError && (
        <Alert variant="error" title="Failed to create conversion" message={createMutation.error.message} />
      )}
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Input
          value={fromUom}
          onChange={(e) => setFromUom(e.target.value)}
          placeholder="From UoM"
          required
        />
        <Input
          value={toUom}
          onChange={(e) => setToUom(e.target.value)}
          placeholder="To UoM"
          required
        />
        <Input
          type="number"
          value={factor}
          onChange={(e) => setFactor(Number(e.target.value))}
          placeholder="Factor"
          required
          min="0.000000001"
          step="any"
        />
        <Button type="submit" disabled={createMutation.isPending}>
          Add
        </Button>
      </form>
      <div className="flow-root">
        <div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
          <div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
            <table className="min-w-full divide-y divide-gray-300">
              <thead>
                <tr>
                  <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-0">
                    From UoM
                  </th>
                  <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    To UoM
                  </th>
                  <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                    Factor
                  </th>
                  <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-0">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {conversions.map((conversion) => (
                  <tr key={conversion.id}>
                    <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-0">
                      {conversion.fromUom}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">{conversion.toUom}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">{conversion.factor}</td>
                    <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-0">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => deleteMutation.mutate(conversion.id)}
                        disabled={deleteMutation.isPending}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
