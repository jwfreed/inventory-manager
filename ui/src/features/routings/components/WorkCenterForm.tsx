import React from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { listLocations } from '../../locations/api/locations';
import type { WorkCenter } from '../types';

interface WorkCenterFormProps {
  initialData?: Partial<WorkCenter>;
  onSubmit: (data: Partial<WorkCenter>) => void;
  onCancel: () => void;
}

export const WorkCenterForm: React.FC<WorkCenterFormProps> = ({ initialData, onSubmit, onCancel }) => {
  const { register, handleSubmit, formState: { errors } } = useForm<Partial<WorkCenter>>({
    defaultValues: {
      code: initialData?.code ?? '',
      name: initialData?.name ?? '',
      locationId: initialData?.locationId ?? '',
      status: initialData?.status ?? 'active',
      description: initialData?.description ?? '',
      hourlyRate: initialData?.hourlyRate ?? 0,
      capacity: initialData?.capacity ?? 1
    }
  });

  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => listLocations(),
    staleTime: 5 * 60 * 1000
  });

  const locations = Array.isArray(locationsData) ? locationsData : (locationsData?.data ?? []);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700">Code</label>
        <input
          {...register('code', { required: 'Code is required' })}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
        {errors.code && <span className="text-red-500 text-sm">{errors.code.message}</span>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Production Area Name</label>
        <input
          {...register('name', { required: 'Name is required' })}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
        {errors.name && <span className="text-red-500 text-sm">{errors.name.message}</span>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Location (Receive-to)</label>
        <select
          {...register('locationId', { required: 'Receive-to location is required' })}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        >
          <option value="">Select Location</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name} ({loc.code})
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          When a routing step uses this production area, outputs are received into this location by default.
        </p>
        {errors.locationId && <span className="text-red-500 text-sm">{errors.locationId.message}</span>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Status</label>
        <select
          {...register('status')}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">Description (optional)</label>
        <textarea
          {...register('description')}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>

      <details className="rounded-md border border-gray-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-700">Advanced</summary>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Hourly Rate (informational only)</label>
            <input
              type="number"
              step="0.01"
              {...register('hourlyRate', { valueAsNumber: true, min: 0 })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Capacity (informational only)</label>
            <input
              type="number"
              {...register('capacity', { valueAsNumber: true, min: 1 })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Capacity and hourly rate are stored for reference and reporting only.
        </p>
      </details>

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
