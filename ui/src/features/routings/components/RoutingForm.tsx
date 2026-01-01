import React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { getWorkCenters } from '../api';
import type { Routing, RoutingStep } from '../types';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';

interface RoutingFormProps {
  itemId: string;
  initialData?: Partial<Routing>;
  onSubmit: (data: Partial<Routing>) => void;
  onCancel: () => void;
}

export const RoutingForm: React.FC<RoutingFormProps> = ({ itemId, initialData, onSubmit, onCancel }) => {
  const { register, control, handleSubmit, formState: { errors } } = useForm<Partial<Routing>>({
    defaultValues: {
      name: '',
      version: '1.0',
      isDefault: false,
      status: 'draft',
      notes: '',
      steps: [],
      ...initialData,
      itemId
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'steps'
  });

  const { data: workCenters } = useQuery({
    queryKey: ['workCenters'],
    queryFn: getWorkCenters
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="grid grid-cols-1 gap-y-6 gap-x-4 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <label className="block text-sm font-medium text-gray-700">Name</label>
          <input
            {...register('name', { required: 'Name is required' })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
          {errors.name && <span className="text-red-500 text-sm">{errors.name.message}</span>}
        </div>

        <div className="sm:col-span-3">
          <label className="block text-sm font-medium text-gray-700">Version</label>
          <input
            {...register('version', { required: 'Version is required' })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
          {errors.version && <span className="text-red-500 text-sm">{errors.version.message}</span>}
        </div>

        <div className="sm:col-span-3">
          <label className="block text-sm font-medium text-gray-700">Status</label>
          <select
            {...register('status')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="obsolete">Obsolete</option>
          </select>
        </div>

        <div className="sm:col-span-3 flex items-center pt-6">
          <input
            type="checkbox"
            {...register('isDefault')}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <label className="ml-2 block text-sm text-gray-900">Default Routing</label>
        </div>

        <div className="sm:col-span-6">
          <label className="block text-sm font-medium text-gray-700">Notes</label>
          <textarea
            {...register('notes')}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
          />
        </div>
      </div>

      <div className="border-t border-gray-200 pt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium leading-6 text-gray-900">Routing Steps</h3>
          <button
            type="button"
            onClick={() => append({ 
              sequenceNumber: (fields.length + 1) * 10, 
              workCenterId: '', 
              setupTimeMinutes: 0, 
              runTimeMinutes: 0, 
              machineTimeMinutes: 0 
            } as RoutingStep)}
            className="inline-flex items-center rounded-md border border-transparent bg-indigo-100 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            <PlusIcon className="-ml-1 mr-2 h-5 w-5" aria-hidden="true" />
            Add Step
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {fields.map((field: any, index: number) => (
            <div key={field.id} className="flex flex-col space-y-4 rounded-md border border-gray-200 p-4 sm:flex-row sm:space-y-0 sm:space-x-4">
              <div className="w-20">
                <label className="block text-xs font-medium text-gray-500">Seq</label>
                <input
                  type="number"
                  {...register(`steps.${index}.sequenceNumber`, { valueAsNumber: true, required: true })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500">Work Center</label>
                <select
                  {...register(`steps.${index}.workCenterId`, { required: true })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                >
                  <option value="">Select Work Center</option>
                  {workCenters?.map((wc) => (
                    <option key={wc.id} value={wc.id}>
                      {wc.name} ({wc.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500">Description</label>
                <input
                  {...register(`steps.${index}.description`)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="w-24">
                <label className="block text-xs font-medium text-gray-500">Setup (min)</label>
                <input
                  type="number"
                  step="0.1"
                  {...register(`steps.${index}.setupTimeMinutes`, { valueAsNumber: true, min: 0 })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="w-24">
                <label className="block text-xs font-medium text-gray-500">Run (min)</label>
                <input
                  type="number"
                  step="0.1"
                  {...register(`steps.${index}.runTimeMinutes`, { valueAsNumber: true, min: 0 })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="w-24">
                <label className="block text-xs font-medium text-gray-500">Machine (min)</label>
                <input
                  type="number"
                  step="0.1"
                  {...register(`steps.${index}.machineTimeMinutes`, { valueAsNumber: true, min: 0 })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              <div className="flex items-end pb-1">
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="text-red-600 hover:text-red-900"
                >
                  <TrashIcon className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end space-x-3 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex justify-center rounded-md border border-transparent bg-indigo-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Save
        </button>
      </div>
    </form>
  );
};
