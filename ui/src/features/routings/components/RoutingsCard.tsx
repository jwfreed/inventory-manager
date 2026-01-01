import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRoutingsByItemId, createRouting, updateRouting, getWorkCenters } from '../api';
import { RoutingForm } from './RoutingForm';
import type { Routing } from '../types';
import { PlusIcon, PencilIcon } from '@heroicons/react/24/outline';
import { Card } from '../../../components/Card';

interface RoutingsCardProps {
  itemId: string;
}

export const RoutingsCard: React.FC<RoutingsCardProps> = ({ itemId }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editingRouting, setEditingRouting] = useState<Routing | null>(null);
  const queryClient = useQueryClient();

  const { data: routings, isLoading: isLoadingRoutings } = useQuery({
    queryKey: ['routings', itemId],
    queryFn: () => getRoutingsByItemId(itemId)
  });

  const { data: workCenters } = useQuery({
    queryKey: ['workCenters'],
    queryFn: getWorkCenters
  });

  const workCenterMap = React.useMemo(() => {
    const map = new Map<string, string>();
    workCenters?.forEach(wc => map.set(wc.id, wc.name));
    return map;
  }, [workCenters]);

  const createMutation = useMutation({
    mutationFn: createRouting,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routings', itemId] });
      setIsEditing(false);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Routing> }) => updateRouting(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routings', itemId] });
      setIsEditing(false);
      setEditingRouting(null);
    }
  });

  const handleSubmit = (data: Partial<Routing>) => {
    if (editingRouting) {
      updateMutation.mutate({ id: editingRouting.id, data });
    } else {
      createMutation.mutate({ ...data, itemId });
    }
  };

  const handleEdit = (routing: Routing) => {
    setEditingRouting(routing);
    setIsEditing(true);
  };

  const handleAddNew = () => {
    setEditingRouting(null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditingRouting(null);
  };

  if (isLoadingRoutings) return <div>Loading...</div>;

  if (isEditing) {
    return (
      <Card>
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium leading-6 text-gray-900 mb-4">
            {editingRouting ? 'Edit Routing' : 'Add Routing'}
          </h3>
          <RoutingForm
            itemId={itemId}
            initialData={editingRouting || {}}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="px-4 py-5 sm:px-6 flex justify-between items-center">
        <div>
          <h3 className="text-lg font-medium leading-6 text-gray-900">Production Routings</h3>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Manage manufacturing steps and work centers.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddNew}
          className="inline-flex items-center rounded-md border border-transparent bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
          Add Routing
        </button>
      </div>
      <div className="border-t border-gray-200">
        {routings && routings.length > 0 ? (
          <ul role="list" className="divide-y divide-gray-200">
            {routings.map((routing) => (
              <li key={routing.id} className="px-4 py-4 sm:px-6">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <div className="flex items-center">
                      <p className="truncate text-sm font-medium text-indigo-600">{routing.name}</p>
                      <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                        v{routing.version}
                      </span>
                      {routing.isDefault && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                          Default
                        </span>
                      )}
                      <span className={`ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        routing.status === 'active' ? 'bg-green-100 text-green-800' : 
                        routing.status === 'draft' ? 'bg-yellow-100 text-yellow-800' : 
                        'bg-red-100 text-red-800'
                      }`}>
                        {routing.status}
                      </span>
                    </div>
                    <div className="mt-2 sm:flex sm:justify-between">
                      <div className="sm:flex">
                        <p className="flex items-center text-sm text-gray-500">
                          {routing.steps?.length || 0} Steps
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="ml-5 flex-shrink-0">
                    <button
                      onClick={() => handleEdit(routing)}
                      className="text-indigo-600 hover:text-indigo-900"
                    >
                      <PencilIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {routing.steps && routing.steps.length > 0 && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <table className="min-w-full divide-y divide-gray-300">
                      <thead>
                        <tr>
                          <th className="text-left text-xs font-medium text-gray-500">Seq</th>
                          <th className="text-left text-xs font-medium text-gray-500">Work Center</th>
                          <th className="text-left text-xs font-medium text-gray-500">Description</th>
                          <th className="text-right text-xs font-medium text-gray-500">Setup</th>
                          <th className="text-right text-xs font-medium text-gray-500">Run</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {routing.steps.map((step) => (
                          <tr key={step.id}>
                            <td className="whitespace-nowrap py-2 text-xs text-gray-900">{step.sequenceNumber}</td>
                            <td className="whitespace-nowrap py-2 text-xs text-gray-500">
                              {workCenterMap.get(step.workCenterId) || step.workCenterId}
                            </td>
                            <td className="whitespace-nowrap py-2 text-xs text-gray-500">{step.description}</td>
                            <td className="whitespace-nowrap py-2 text-right text-xs text-gray-500">{step.setupTimeMinutes}</td>
                            <td className="whitespace-nowrap py-2 text-right text-xs text-gray-500">{step.runTimeMinutes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-5 sm:px-6 text-center text-sm text-gray-500">
            No routings found. Create one to get started.
          </div>
        )}
      </div>
    </Card>
  );
};
