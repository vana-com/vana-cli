/**
 * Response DTO for refiner execution statistics
 * Based on RefinerExecutionStatusResponse from the refinement service API
 */
export interface RefinerExecutionStatsResponse {
  /** The ID of the refiner */
  refiner_id: number;
  
  /** Total number of refinement jobs processed */
  total_jobs: number;
  
  /** Number of successful refinement jobs */
  successful_jobs: number;
  
  /** Number of failed refinement jobs */
  failed_jobs: number;
  
  /** Number of currently processing jobs */
  processing_jobs: number;
  
  /** Number of jobs waiting to be processed */
  submitted_jobs: number;
  
  /** Timestamp of the first job processed */
  first_job_at?: string;
  
  /** Timestamp of the last job processed */
  last_job_at?: string;
  
  /** Average processing time in seconds */
  average_processing_time_seconds: number;
  
  /** Success rate as a decimal (0.0 to 1.0) */
  success_rate: number;
  
  /** Average jobs processed per hour */
  jobs_per_hour: number;
  
  /** Number of days between first and last job */
  processing_period_days?: number;
  
  /** Number of errors by type (last 5-10 most common) */
  error_types: Record<string, number>;
  
  /** Recent error details for debugging */
  recent_errors: Array<{
    error: string;
    timestamp: string;
    job_id?: string;
  }>;
}

/**
 * Example response data structure
 */
export const EXAMPLE_REFINER_EXECUTION_STATS: RefinerExecutionStatsResponse = {
  refiner_id: 1,
  total_jobs: 150,
  successful_jobs: 142,
  failed_jobs: 8,
  processing_jobs: 2,
  submitted_jobs: 5,
  first_job_at: "2024-01-15T10:30:00Z",
  last_job_at: "2024-01-20T14:45:00Z",
  average_processing_time_seconds: 45.7,
  success_rate: 0.947,
  jobs_per_hour: 1.2,
  processing_period_days: 5.18,
  error_types: {
    "VALIDATION_ERROR": 3,
    "TIMEOUT_ERROR": 2,
    "NETWORK_ERROR": 3
  },
  recent_errors: [
    {
      error: "File validation failed",
      timestamp: "2024-01-20T14:30:00Z",
      job_id: "job-123"
    }
  ]
}; 