import { ethers } from 'ethers';
import { RefinerExecutionStatsResponse } from './dto/refiner-execution-stats-response.js';

export class RefinementServiceClient {
    constructor(private baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /**
     * Get refiner execution statistics with cryptographic authentication
     * Based on the query engine client pattern
     */
    async getRefinerExecutionStats(
        refinerId: number, 
        privateKey: string
    ): Promise<RefinerExecutionStatsResponse> {
        try {
            // Ensure private key has 0x prefix
            const formattedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
            
            // Create wallet from private key
            const wallet = new ethers.Wallet(formattedPrivateKey);
            
            // Sign the refiner_id as a string (matching the refinement service implementation)
            const message = refinerId.toString();
            const signature = await wallet.signMessage(message);
            
            // Make the authenticated request
            const url = `${this.baseUrl}/stats/refiner/${refinerId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Refiner-Signature': signature,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                
                try {
                    const errorJson = JSON.parse(errorText);
                    errorMessage = errorJson.detail || errorJson.message || errorMessage;
                } catch {
                    errorMessage = errorText || errorMessage;
                }
                
                throw new Error(errorMessage);
            }

            return await response.json() as RefinerExecutionStatsResponse;
            
        } catch (error) {
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`Failed to get refiner execution stats: ${String(error)}`);
        }
    }
} 