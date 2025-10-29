import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, orderBy, serverTimestamp, getDocs, addDoc, updateDoc } from 'firebase/firestore';

// --- CONFIGURATION ---
// IMPORTANT: These variables are provided automatically in the Canvas environment.
// For local testing, you must replace the placeholders below with your own Firebase config.

const LOCAL_FIREBASE_CONFIG = {
    apiKey: "AIzaSyAtA5djpuON6A2ZICy63exYkz7Wn-22wGA",
    authDomain: "marriage-card-game-tracker.firebaseapp.com",
    projectId: "marriage-card-game-tracker",
    storageBucket: "marriage-card-game-tracker.firebasestorage.app",
    messagingSenderId: "685316561911",
    appId: "1:685316561911:web:7e98dbf0f270014140acf2",
    measurementId: "G-WT2J28GBZT"
};

// Simulated Canvas Globals for local development
const isLocal = typeof __app_id === 'undefined';
const __firebase_config = isLocal ? JSON.stringify(LOCAL_FIREBASE_CONFIG) : (typeof __firebase_config !== 'undefined' ? __firebase_config : JSON.stringify(LOCAL_FIREBASE_CONFIG));
const __initial_auth_token = isLocal ? null : (typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null);

// --- DEFENSIVE CONFIGURATION LOADING ---
let loadedFirebaseConfig = {}; 

try {
    // Attempt to parse the environment's config
    const envConfig = JSON.parse(__firebase_config);
    
    // Only use environment config if it looks valid
    if (envConfig && envConfig.projectId && envConfig.apiKey) {
        loadedFirebaseConfig = envConfig;
    } else {
        console.warn("Environment Firebase config was invalid. Falling back to local config.");
        loadedFirebaseConfig = LOCAL_FIREBASE_CONFIG;
    }
} catch (e) {
    console.warn("Failed to parse environment Firebase config. Falling back to local config.", e);
    loadedFirebaseConfig = LOCAL_FIREBASE_CONFIG;
}


const firebaseConfig = loadedFirebaseConfig;
const initialAuthToken = __initial_auth_token;
const appId = isLocal ? 'local-test-app' : __app_id; // Using 'local-test-app' as a standard ID for local runs
// --- END DEFENSIVE CONFIGURATION LOADING ---


// --- UTILITY FUNCTIONS (Moved outside App) ---

// Utility function to generate a human-readable 6-character game code
const generateGameCode = () => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
};

// Utility function to handle exponential backoff for API calls
const withBackoff = async (fn, maxRetries = 5, delay = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay * (2 ** i)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay * (2 ** i)));
        }
    }
};

// Helper function for clipboard copy
const copyToClipboard = (text, callback) => {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            // Modern async way
            navigator.clipboard.writeText(text).then(() => {
                if (callback) callback();
            });
        } else {
            // Fallback for older/insecure contexts
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed'; // Prevent scrolling
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            if (callback) callback();
        }
    } catch (e) {
        console.warn("Clipboard copy failed:", e);
    }
};


// --- REFACTORED: EXTRACTED COMPONENTS ---

/**
 * Memoized component for a single player's input card.
 * This prevents re-renders of other cards when one is being typed in.
 */
const PlayerInputCard = React.memo(({ name, isShowed, displayValuePower, displayValueHands, handleInputChange }) => {
    return (
        <div key={name} className={`p-4 rounded-lg transition duration-150 ${isShowed ? 'bg-indigo-900 border border-indigo-500 shadow-md' : 'bg-gray-700 border border-gray-600'}`}>
            <h4 className="font-bold text-lg mb-2 flex justify-between items-center">
                {name} 
                {isShowed && <span className="text-xs px-2 py-0.5 bg-indigo-500 rounded-full">SHOWED</span>}
            </h4>
            
            {/* Power Input (for all active) */}
            <div className="mb-3">
                <label className="block text-sm text-gray-400 mb-1">Power ({name})</label>
                <input
                    type="text" 
                    inputMode="decimal"
                    value={displayValuePower}
                    onChange={(e) => handleInputChange(name, 'power', e.target.value)}
                    className="w-full p-2 rounded bg-gray-800 border border-gray-600 focus:ring-pink-500 focus:border-pink-500"
                />
            </div>
            
            {/* Hands Input (only for non-showed active) */}
            {!isShowed && (
                <div>
                    <label className="block text-sm text-gray-400 mb-1">Hands ({name})</label>
                    <input
                        type="text" 
                        inputMode="decimal"
                        value={displayValueHands}
                        onChange={(e) => handleInputChange(name, 'hands', e.target.value)}
                        className="w-full p-2 rounded bg-gray-800 border border-gray-600 focus:ring-pink-500 focus:border-pink-500"
                    />
                </div>
            )}
        </div>
    );
});

// Nested Component for editing a round's scores
const RoundEditModal = React.memo(({ round, onSave, onCancel, playerNames, gameHistory, calculateRoundScores }) => {
        
    const initialRoundIndex = playerNames.indexOf(round.showedPlayer);

    // Convert stored numerical details to strings for the controlled inputs
    const initialInputs = useMemo(() => playerNames.reduce((acc, name) => ({
        ...acc,
        [name]: { 
            power: (round.roundDetails[name]?.power || 0).toString(), 
            hands: (round.roundDetails[name]?.hands || 0).toString() 
        }
    }), {}), [playerNames, round.roundDetails]);

    const [editedInputs, setEditedInputs] = useState(initialInputs);
    const [editedShowedPlayerIndex, setEditedShowedPlayerIndex] = useState(initialRoundIndex >= 0 ? initialRoundIndex : 0);
    const [editedInactivePlayers, setEditedInactivePlayers] = useState(round.inactivePlayers || []);
    
    // Recalculate preview scores whenever inputs or status change in the modal
    const previewScores = useMemo(() => {
        return calculateRoundScores(
            editedInputs, 
            editedShowedPlayerIndex, 
            editedInactivePlayers, 
            round.perPointValue
        );
    }, [editedInputs, editedShowedPlayerIndex, editedInactivePlayers, round.perPointValue, calculateRoundScores]);

    const handleInputEdit = useCallback((name, field, value) => {
        // Validation: Only allow empty string or valid decimal number format
        if (!/^\d*\.?\d*$/.test(value)) {
            return; 
        }
        
        setEditedInputs(prev => ({
            ...prev,
            [name]: {
                ...(prev[name] || {}), // Ensure player object exists
                [field]: value // Store raw string input
            }
        }));
    }, []);

    const toggleInactiveEdit = useCallback((name) => {
        setEditedInactivePlayers(prev => 
            prev.includes(name) 
                ? prev.filter(n => n !== name) 
                : [...prev, name] 
        );
    }, []);
    
    const handleSave = () => {
        const updatedDetails = {
            rawRoundDetails: editedInputs, // Pass the raw string inputs
            showedPlayerIndex: editedShowedPlayerIndex,
            inactivePlayers: editedInactivePlayers,
            perPointValue: round.perPointValue,
        };

        onSave(round.id, updatedDetails);
        onCancel(); // Close modal after save
    };

    if (!round) return null;
    
    const roundNumber = gameHistory.findIndex(h => h.id === round.id) + 1;

    return (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-gray-800 w-full max-w-2xl rounded-xl shadow-2xl p-6 my-8">
                <h3 className="text-2xl font-bold mb-4 text-pink-300">Edit Round #{roundNumber} Details</h3>
                <p className="text-sm text-gray-400 mb-4">Original Point Value: ${round.perPointValue.toFixed(2)}</p>

                <div className="space-y-4">
                    {/* Showed Player Selector */}
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">Showed Player</label>
                        <select
                            value={editedShowedPlayerIndex}
                            onChange={(e) => setEditedShowedPlayerIndex(parseInt(e.target.value, 10))}
                            className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                        >
                            {playerNames.map((name, index) => {
                                const isInactive = editedInactivePlayers.includes(name);
                                return (
                                    <option 
                                        key={index} 
                                        value={index} 
                                        disabled={isInactive} 
                                        className={isInactive ? 'text-red-400' : 'text-white'}
                                    >
                                        {name} {isInactive ? '(Inactive)' : ''}
                                    </option>
                                );
                            })}
                        </select>
                    </div>
                    
                    {/* Player Status Toggler */}
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Set Player Status</label>
                        <div className="flex flex-wrap gap-2">
                            {playerNames.map((name) => {
                                const isInactive = editedInactivePlayers.includes(name);
                                return (
                                    <button
                                        key={name}
                                        onClick={() => toggleInactiveEdit(name)}
                                        className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                                            isInactive 
                                                ? 'bg-red-700 text-white hover:bg-red-600' 
                                                : 'bg-green-700 text-white hover:bg-green-600'
                                        }`}
                                    >
                                        {name} ({isInactive ? 'OUT' : 'IN'})
                                    </button>
                                );
                            })}
                        </div>
                    </div>


                    {/* Hands and Power Inputs (Raw Data) */}
                    <div className="max-h-60 overflow-y-auto pr-2 border-t border-gray-700 pt-4">
                        <p className="text-lg font-bold text-indigo-300 mb-2">Hands & Power Input:</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {playerNames.map(name => {
                                const isShowed = name === playerNames[editedShowedPlayerIndex];
                                const isInactive = editedInactivePlayers.includes(name);
                                
                                const power = editedInputs[name]?.power ?? '';
                                const hands = editedInputs[name]?.hands ?? '';

                                if (isInactive) return null; // Hide inactive players
                                
                                return (
                                    <div key={name} className={`p-3 rounded-lg ${isShowed ? 'bg-indigo-900' : 'bg-gray-700'}`}>
                                        <h4 className="font-semibold text-white mb-2">{name}</h4>
                                        
                                        {/* Power Input */}
                                        <div className="mb-2">
                                            <label className="block text-xs text-gray-400">Power</label>
                                            <input
                                                type="text" 
                                                inputMode="decimal"
                                                value={power}
                                                onChange={(e) => handleInputEdit(name, 'power', e.target.value)}
                                                className="w-full p-2 rounded bg-gray-800 border border-gray-600 text-right text-sm"
                                            />
                                        </div>

                                        {/* Hands Input (Not for Showed Player) */}
                                        {!isShowed && (
                                            <div>
                                                <label className="block text-xs text-gray-400">Hands</label>
                                                <input
                                                    type="text" 
                                                    inputMode="decimal"
                                                    value={hands}
                                                    onChange={(e) => handleInputEdit(name, 'hands', e.target.value)}
                                                    className="w-full p-2 rounded bg-gray-800 border border-gray-600 text-right text-sm"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Recalculated Score Preview */}
                    <div className="pt-4 border-t border-gray-700">
                        <p className="text-lg font-bold text-pink-300 mb-2">Recalculated Scores:</p>
                        <div className="flex flex-wrap gap-3">
                            {playerNames.map(name => (
                                <div key={`preview-${name}`} className="bg-gray-700 p-2 rounded-lg text-center flex-grow min-w-[80px]">
                                    <p className="text-xs text-gray-400">{name}</p>
                                    <p className={`font-bold text-md ${previewScores[name] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {(previewScores[name] > 0 ? '+' : '') + (previewScores[name] !== undefined ? previewScores[name].toFixed(2) : '0.00')}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>


                <div className="flex justify-end space-x-4 mt-6">
                    <button 
                        onClick={onCancel}
                        className="px-4 py-2 bg-gray-500 hover:bg-gray-600 rounded-lg font-bold transition duration-150"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 bg-pink-600 hover:bg-pink-700 rounded-lg font-bold transition duration-150"
                    >
                        Save & Recalculate
                    </button>
                </div>
            </div>
        </div>
    );
});


// 5. GamePlay View
const GamePlayView = React.memo(({
    currentGame,
    gameHistory,
    totalScores,
    message,
    setMessage,
    db,
    handleSaveRound,
    handleMarkDone,
    handleAddNewPlayer,
    handleUpdatePointValue,
    handleEditRoundScore,
    calculateRoundScores,
    inactivePlayers,
    toggleInactive,
    showedPlayerIndex,
    setShowedPlayerIndex,
    roundInputs,
    handleInputChange
}) => {
    
    const [newPlayerName, setNewPlayerName] = useState(''); // State for new player input
    const [newPointValue, setNewPointValue] = useState(currentGame?.perPointValue.toFixed(2) || '0.00'); // State for new point value input
    
    // --- State for Modals ---
    const [roundToEdit, setRoundToEdit] = useState(null);
    const [expandedRoundId, setExpandedRoundId] = useState(null);

    const startEdit = (round) => setRoundToEdit(round);
    const cancelEdit = () => setRoundToEdit(null);
    // --- End State for Modals ---


    useEffect(() => {
        // Update the local input state when currentGame changes
        if (currentGame) {
            setNewPointValue(currentGame.perPointValue.toFixed(2));
        }
    }, [currentGame]);


    if (!currentGame) {
        return <div className="text-center text-xl text-yellow-400 p-8">Loading game details...</div>;
    }
    
    const isGameDone = currentGame.status === 'done';
    
    // This will recalculate on every render, but it's cheap
    const previewScores = calculateRoundScores(roundInputs, showedPlayerIndex, inactivePlayers, currentGame.perPointValue);
    
    const activePlayerNames = currentGame.playerNames.filter(name => !inactivePlayers.includes(name));
    
    // Toggle function for mobile history
    const toggleRoundExpansion = (id) => {
        setExpandedRoundId(id === expandedRoundId ? null : id);
    };


    return (
        <div className="relative">
            
            {/* Modals */}
            {roundToEdit && (
                <RoundEditModal
                    round={roundToEdit}
                    onSave={handleEditRoundScore}
                    onCancel={cancelEdit}
                    playerNames={currentGame.playerNames}
                    gameHistory={gameHistory}
                    calculateRoundScores={calculateRoundScores} // Pass the calculator function
                />
            )}
            
            {/* Game Info and Share ID */}
            <div className="max-w-4xl w-full mx-auto bg-gray-700 p-4 rounded-xl shadow-inner mb-6">
                <h2 className="text-2xl font-bold text-indigo-200">{currentGame.name}</h2>
                <p className="text-sm text-gray-400">Current Point Value: <span className="font-bold text-pink-400">${currentGame.perPointValue.toFixed(2)}</span></p>
                <div className="flex items-center justify-between mt-2 p-2 bg-gray-800 rounded-lg">
                    <span className="text-sm font-mono text-pink-400 select-all">
                        Game Code: {currentGame.gameCode}
                        <span className="ml-4 text-xs text-gray-500 hidden sm:inline">({currentGame.id.substring(0, 8)}...)</span>
                    </span>
                    <button
                        onClick={() => copyToClipboard(currentGame.gameCode, () => setMessage('Game Code copied!'))}
                        className="text-xs px-3 py-1 bg-indigo-500 hover:bg-indigo-600 rounded-lg transition duration-150"
                    >
                        Copy Code
                    </button>
                </div>
            </div>
            
            {/* ------------------------------------------------------------- */}
            {/* 1. SCOREBOARD & HISTORY (MOVED TO THE TOP)                 */}
            {/* ------------------------------------------------------------- */}
            <div className="max-w-4xl w-full mx-auto bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
                <h2 className="text-2xl font-bold mb-4 border-b border-gray-700 pb-2 text-indigo-300">
                    {isGameDone ? 'Final Leaderboard' : 'Current Scoreboard'}
                </h2>
                
                {/* Leaderboard Section (Optimized for Mobile) */}
                <div className="mb-6 space-y-2">
                    {totalScores.map((player, index) => (
                        <div key={player.name} className={`flex justify-between items-center p-3 rounded-lg ${index % 2 === 0 ? 'bg-gray-700/50' : 'bg-gray-700'}`}>
                            <div className="flex items-center space-x-3">
                                <span className="text-xl font-extrabold w-8 text-center text-indigo-400">#{index + 1}</span>
                                <span className="text-lg font-semibold">{player.name}</span>
                            </div>
                            <span className={`text-xl font-extrabold text-right ${player.score >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {player.score > 0 ? '+' : ''}{player.score.toFixed(2)}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Mark Done Button */}
                {!isGameDone && (
                    <button
                        onClick={handleMarkDone}
                        className="w-full py-3 mt-4 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 transition duration-150"
                        disabled={!db}
                    >
                        Mark Game as Done (Finalize Leaderboard)
                    </button>
                )}

                {/* Round History (Optional) */}
                {gameHistory.length > 0 && (
                    <div className="mt-8 pt-4 border-t border-gray-700">
                        <h3 className="text-xl font-semibold mb-3 text-gray-300">Round History ({gameHistory.length} Rounds)</h3>

                        {/* *
                          * CSS FIX: Changed 'sm:hidden' to 'md:hidden'.
                          * This shows the mobile list view on 'xs' AND 'sm' screens.
                          * It hides it starting at 'md' (768px).
                          *
                        */}
                        {/* MOBILE LIST VIEW (Default for small screens) */}
                        <div className="md:hidden space-y-3">
                            {gameHistory.map((round, roundIndex) => {
                                const isExpanded = round.id === expandedRoundId;
                                const roundNumber = roundIndex + 1;
                                
                                return (
                                    <div key={round.id} className="bg-gray-700 rounded-lg shadow-md overflow-hidden">
                                        {/* Header: Always visible */}
                                        <div 
                                            className="flex justify-between items-center p-4 cursor-pointer hover:bg-gray-600 transition"
                                            onClick={() => toggleRoundExpansion(round.id)}
                                        >
                                            <div className="flex flex-col">
                                                <span className="font-bold text-lg text-pink-300">Round #{roundNumber}</span>
                                                <span className="text-sm text-gray-400">Showed: {round.showedPlayer}</span>
                                            </div>
                                            <div className="flex items-center space-x-2">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); startEdit(round); }}
                                                    disabled={isGameDone}
                                                    className="text-xs px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg disabled:opacity-50"
                                                >
                                                    Edit
                                                </button>
                                                <span className="text-xl text-indigo-400">{isExpanded ? '▲' : '▼'}</span>
                                            </div>
                                        </div>

                                        {/* Details: Collapsible */}
                                        {isExpanded && (
                                            <div className="p-4 pt-0 border-t border-gray-600">
                                                <p className="text-sm font-semibold text-gray-300 mb-2">Scores:</p>
                                                <div className="space-y-1">
                                                    {currentGame.playerNames.map(name => {
                                                        const score = round.scores[name] !== undefined ? round.scores[name] : 0;
                                                        const isInactiveInRound = round.inactivePlayers && round.inactivePlayers.includes(name);
                                                        
                                                        return (
                                                            <div key={name} className="flex justify-between text-sm py-1 border-b border-gray-700 last:border-b-0">
                                                                <span className="font-medium text-indigo-300">{name}</span>
                                                                <span className={`font-semibold ${
                                                                    isInactiveInRound 
                                                                        ? 'text-gray-500 italic' 
                                                                        : score >= 0 ? 'text-green-400' : 'text-red-400'
                                                                }`}>
                                                                    {isInactiveInRound ? 'N/A' : (score > 0 ? '+' : '') + score.toFixed(2)}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* *
                          * CSS FIX: Changed 'hidden sm:block' to 'hidden md:block'.
                          * This hides the desktop table on 'xs' AND 'sm' screens.
                          * It shows it starting at 'md' (768px).
                          *
                        */}
                        {/* DESKTOP TABLE VIEW (Hidden on small screens) */}
                        <div className="hidden md:block overflow-x-auto rounded-lg border border-gray-700">
                            <table className="min-w-full divide-y divide-gray-700">
                                <thead className="bg-gray-700 sticky top-0">
                                    <tr>
                                        <th className="px-3 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider min-w-[120px]"># / Showed</th>
                                        {currentGame.playerNames.map((name, index) => (
                                            <th key={index} className="px-3 py-3 text-center text-xs font-medium text-gray-300 uppercase tracking-wider min-w-[80px]">
                                                {name}
                                            </th>
                                        ))}
                                        <th className="px-3 py-3 text-center text-xs font-medium text-gray-300 uppercase tracking-wider min-w-[80px]">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-700">
                                    {gameHistory.map((round, roundIndex) => (
                                        <tr key={round.id} className="hover:bg-gray-700/50 transition duration-100">
                                            <td className="px-3 py-3 whitespace-nowrap text-sm font-medium text-gray-300">
                                                #{roundIndex + 1}
                                                <span className="block text-xs text-indigo-400 font-normal">({round.showedPlayer})</span>
                                                {round.inactivePlayers && round.inactivePlayers.length > 0 && (
                                                    <span className="block text-xs text-yellow-400 font-normal">({round.inactivePlayers.length} out)</span>
                                                )}
                                            </td>
                                            {currentGame.playerNames.map((name, playerIndex) => {
                                                const score = round.scores[name] !== undefined ? round.scores[name] : 0;
                                                const isInactiveInRound = round.inactivePlayers && round.inactivePlayers.includes(name);
                                                return (
                                                    <td 
                                                        key={playerIndex} 
                                                        className={`px-3 py-3 whitespace-nowrap text-sm font-semibold text-center ${
                                                            isInactiveInRound 
                                                                ? 'text-gray-500 italic' 
                                                                : score >= 0 ? 'text-green-400' : 'text-red-400'
                                                        }`}
                                                    >
                                                        {isInactiveInRound ? 'N/A' : (score > 0 ? '+' : '') + score.toFixed(2)}
                                                    </td>
                                                );
                                            })}
                                            <td className="px-3 py-3 whitespace-nowrap text-center">
                                                <button
                                                    onClick={() => startEdit(round)}
                                                    disabled={isGameDone}
                                                    className="text-xs px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg disabled:opacity-50"
                                                >
                                                    Edit
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>


            {/* ------------------------------------------------------------- */}
            {/* 2. ROUND INPUTS (MOVED BELOW LEADERBOARD)                */}
            {/* ------------------------------------------------------------- */}
            
            {/* Feature Modifications (Only visible if game is not done) */}
            {!isGameDone && (
                <div className="max-w-4xl w-full mx-auto p-6 rounded-xl shadow-2xl mb-8 bg-gray-800">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6"> 
                        {/* Add Player Section */}
                        <div>
                            <h3 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2 text-pink-300">Add New Player</h3>
                            <div className="flex flex-col space-y-3">
                                <input
                                    type="text"
                                    value={newPlayerName}
                                    onChange={(e) => setNewPlayerName(e.target.value)}
                                    placeholder="Enter name"
                                    className="flex-grow p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                                />
                                <button
                                    onClick={() => {
                                        handleAddNewPlayer(newPlayerName);
                                        setNewPlayerName(''); // Clear input after clicking
                                    }}
                                    disabled={!newPlayerName.trim() || currentGame.playerNames.length >= 8}
                                    className="px-4 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg disabled:opacity-50 transition duration-150"
                                >
                                    Add Player
                                </button>
                            </div>
                            {currentGame.playerNames.length >= 8 && <p className="text-sm text-yellow-400 mt-2">Max 8 players reached.</p>}
                        </div>

                        {/* Modify Point Value Section */}
                        <div>
                            <h3 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2 text-pink-300">Modify Point Value</h3>
                            <div className="flex flex-col space-y-3">
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0.01"
                                    value={newPointValue}
                                    onChange={(e) => setNewPointValue(e.target.value)}
                                    placeholder="New Point Value ($)"
                                    className="flex-grow p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                                />
                                <button
                                    onClick={() => handleUpdatePointValue(newPointValue)}
                                    disabled={parseFloat(newPointValue) === currentGame.perPointValue}
                                    className="px-4 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-bold rounded-lg disabled:opacity-50 transition duration-150"
                                >
                                    Update Value
                                </button>
                            </div>
                            <p className="text-sm text-gray-400 mt-2">Applies to all subsequent rounds.</p>
                        </div>
                    </div>
                </div>
            )}
            
            {/* New Round Input (Hidden if game is done) */}
            {!isGameDone && (
                <div className="max-w-4xl w-full mx-auto bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
                    <h2 className="text-2xl font-bold mb-4 border-b border-gray-700 pb-2 text-indigo-300">New Round Setup</h2>

                    {/* Active/Inactive Toggler */}
                    <div className="mb-6">
                        <label className="block text-lg font-medium text-gray-300 mb-2">Set Player Status (Click to Toggle)</label>
                        <div className="flex flex-wrap gap-3">
                            {currentGame.playerNames.map((name, index) => {
                                const isInactive = inactivePlayers.includes(name);
                                return (
                                    <button
                                        key={index}
                                        onClick={() => toggleInactive(name)}
                                        className={`flex items-center px-3 py-2 rounded-full font-semibold text-xs sm:text-sm transition duration-150 ${
                                            isInactive 
                                                ? 'bg-gray-600 text-gray-300 hover:bg-gray-500' 
                                                : 'bg-green-600 text-white hover:bg-green-700'
                                        }`}
                                    >
                                        {name}
                                        <span className="ml-1 text-[10px] sm:text-xs">
                                            {isInactive ? ' (SITTING OUT)' : ' (ACTIVE)'}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-sm text-gray-500 mt-2">Active Players This Round: **{activePlayerNames.length}**</p>
                    </div>
                    
                    {/* Showed Player Selector */}
                    <div className="mb-6 border-t border-gray-700 pt-6">
                        <label className="block text-lg font-medium text-gray-300 mb-2">Showed Player</label>
                        <select
                            value={showedPlayerIndex}
                            onChange={(e) => setShowedPlayerIndex(parseInt(e.target.value, 10))}
                            className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                        >
                            {currentGame.playerNames.map((name, index) => {
                                const isInactive = inactivePlayers.includes(name);
                                return (
                                    <option 
                                        key={index} 
                                        value={index} 
                                        disabled={isInactive} 
                                        className={isInactive ? 'text-red-400' : 'text-white'}
                                    >
                                        {name} {isInactive ? '(Inactive)' : ''}
                                    </option>
                                );
                            })}
                        </select>
                        {inactivePlayers.includes(currentGame.playerNames[showedPlayerIndex]) && (
                            <p className="text-sm text-red-400 mt-1">Warning: Showed Player must be active.</p>
                        )}
                    </div>
                    
                    <h3 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2 text-indigo-300 pt-2">Enter Hands and Power</h3>
                    
                    {/* Individual Player Inputs (Optimized for 1 or 2 columns based on screen size) */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {activePlayerNames.map((name) => {
                            const index = currentGame.playerNames.indexOf(name);
                            const isShowed = index === showedPlayerIndex;
                            
                            const displayValuePower = roundInputs[name]?.power ?? '';
                            const displayValueHands = roundInputs[name]?.hands ?? '';
                            
                            return (
                                <PlayerInputCard
                                    key={name}
                                    name={name}
                                    isShowed={isShowed}
                                    displayValuePower={displayValuePower}
                                    displayValueHands={displayValueHands}
                                    handleInputChange={handleInputChange}
                                />
                            );
                        })}
                    </div>
                    
                    {/* Score Preview and Save Button */}
                    <div className="mt-8 pt-4 border-t border-gray-700">
                        <h3 className="text-xl font-semibold mb-3 text-indigo-300">Round Score Preview:</h3>
                        <div className="flex flex-wrap gap-4 mb-4">
                            {currentGame.playerNames.map((name) => (
                                <div key={`preview-${name}`} className="bg-gray-700 p-3 rounded-lg text-center flex-grow min-w-[120px]">
                                    <p className="text-sm text-gray-400">{name}</p>
                                    <p className={`font-bold text-lg ${previewScores[name] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {previewScores[name] !== undefined ? (previewScores[name] > 0 ? '+' : '') + previewScores[name].toFixed(2) : '0.00'}
                                    </p>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={handleSaveRound}
                            disabled={!db || isGameDone || inactivePlayers.includes(currentGame.playerNames[showedPlayerIndex])}
                            className="w-full py-3 bg-pink-600 hover:bg-pink-700 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 transition duration-150"
                        >
                            {db ? 'Calculate & Save Round' : 'Connecting to DB...'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
});

// 6. CreateGame View
const CreateGameView = React.memo(({ db, userId, setMessage, setActiveGameId, setView }) => {
    const [gameName, setGameName] = useState('');
    const [numPlayers, setNumPlayers] = useState(3);
    const [perPointValue, setPerPointValue] = useState(0.5);
    const [playerNamesInput, setPlayerNamesInput] = useState(['Rishabh', 'Friend 1', 'Friend 2']);

    useEffect(() => {
        // Adjust player name array length when numPlayers changes
        setPlayerNamesInput(prevNames => {
            const newNames = Array.from({ length: numPlayers }, (_, i) => prevNames[i] || `Player ${i + 1}`);
            return newNames;
        });
    }, [numPlayers]);
    
    const handleCreate = async () => {
        if (!db || !userId || !gameName || playerNamesInput.slice(0, numPlayers).some(name => name.trim() === '')) {
            setMessage("Please fill in a game name and all player names.");
            return;
        }

        const gameCode = generateGameCode();

        const newGameData = {
            name: gameName,
            perPointValue: parseFloat(perPointValue),
            playerNames: playerNamesInput.slice(0, numPlayers).filter(name => name.trim() !== ''),
            status: 'active',
            createdAt: serverTimestamp(),
            createdBy: userId,
            lastUpdated: serverTimestamp(),
            finalLeaderboard: null,
            gameCode: gameCode,
        };

        const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games`);

        try {
            setMessage('Creating new game... ⏳');
            const docRef = await withBackoff(() => addDoc(gamesCollectionRef, newGameData));
            
            setMessage(`Game "${gameName}" created successfully! Game Code: ${gameCode}`);
            setActiveGameId(docRef.id);
            setView('gameplay');
        } catch (error) {
            console.error("Error creating game:", error);
            setMessage("Error creating game. Check console.");
        }
    };

    return (
        <div className="max-w-xl w-full bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
            <h2 className="text-3xl font-bold mb-6 text-pink-300">Start a New Game</h2>
            
            <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Game Name</label>
                    <input
                        type="text"
                        value={gameName}
                        onChange={(e) => setGameName(e.target.value)}
                        placeholder="e.g., Diwali 2024 Marriage"
                        className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                    />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">Number of Players (2-8)</label>
                        <input
                            type="number"
                            min="2"
                            max="8"
                            value={numPlayers}
                            onChange={(e) => setNumPlayers(Math.max(2, Math.min(8, parseInt(e.target.value) || 2)))}
                            className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">Per Point Value ($)</label>
                        <input
                            type="number"
                            step="0.01"
                            value={perPointValue}
                            onChange={(e) => setPerPointValue(parseFloat(e.target.value) || 0)}
                            className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500"
                        />
                    </div>
                </div>

                <h3 className="text-xl font-semibold mt-4 text-gray-300">Player Names</h3>
                <div className="grid grid-cols-2 gap-4">
                    {playerNamesInput.slice(0, numPlayers).map((name, index) => (
                        <input
                            key={index}
                            type="text"
                            value={name}
                            onChange={(e) => {
                                const updatedNames = [...playerNamesInput];
                                updatedNames[index] = e.target.value;
                                setPlayerNamesInput(updatedNames);
                            }}
                            placeholder={`Player ${index + 1}`}
                            className="p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-pink-500 focus:border-pink-500"
                        />
                    ))}
                </div>
            </div>

            <button
                onClick={handleCreate}
                disabled={!db || !gameName || playerNamesInput.slice(0, numPlayers).some(name => name.trim() === '')}
                className="w-full py-3 mt-8 bg-pink-600 hover:bg-pink-700 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 transition duration-150"
            >
                Create Game
            </button>
        </div>
    );
});

// 7. Dashboard View
const DashboardView = React.memo(({ db, isAuthReady, appId, setMessage, setView, setActiveGameId }) => {
    const [gamesList, setGamesList] = useState([]);
    const [filter, setFilter] = useState('active'); // 'active' or 'done'
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState(''); // NEW: Search state

    useEffect(() => {
        if (!db || !isAuthReady) return;

        setLoading(true);
        const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games`);
        
        const q = query(gamesCollectionRef, orderBy('lastUpdated', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const games = [];
            snapshot.forEach((doc) => {
                games.push({ id: doc.id, ...doc.data() });
            });
            setGamesList(games);
            setLoading(false);
        }, (error) => {
            console.error("Error fetching dashboard:", error);
            setMessage("Error loading dashboard. See console.");
            setLoading(false);
        });

        return () => unsubscribe();
    }, [db, isAuthReady, appId, setMessage]);

    const filteredGames = useMemo(() => gamesList.filter(game => {
        // Apply status filter
        const statusMatch = game.status === filter;
        
        // Apply search filter (case-insensitive check against name and gameCode)
        const searchLower = searchQuery.toLowerCase();
        const searchMatch = !searchQuery || 
                            game.name.toLowerCase().includes(searchLower) ||
                            (game.gameCode && game.gameCode.toLowerCase().includes(searchLower));

        return statusMatch && searchMatch;
    }), [gamesList, filter, searchQuery]);
    
    return (
        <div className="max-w-4xl w-full bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
            <h2 className="text-3xl font-bold mb-6 text-pink-300">Game Dashboard</h2>
            
            <input
                type="text"
                placeholder="Search by Game Name or Code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full p-3 rounded-lg bg-gray-700 border border-gray-600 text-white focus:ring-indigo-500 focus:border-indigo-500 mb-6"
            />

            <div className="flex justify-start mb-4 space-x-4 border-b border-gray-700 pb-2">
                <button
                    onClick={() => setFilter('active')}
                    className={`px-4 py-2 rounded-lg font-semibold transition duration-150 ${
                        filter === 'active' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                    Active Games
                </button>
                <button
                    onClick={() => setFilter('done')}
                    className={`px-4 py-2 rounded-lg font-semibold transition duration-150 ${
                        filter === 'done' ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                    Completed Games
                </button>
            </div>

            {loading ? (
                <div className="text-center py-8 text-indigo-400 animate-pulse">Loading games...</div>
            ) : (
                <div className="space-y-3">
                    {filteredGames.length === 0 ? (
                        <p className="text-center text-gray-400 py-8">
                            No {filter} games found matching your search. {filter === 'active' && <button onClick={() => setView('create')} className="text-pink-400 hover:underline">Create a new one!</button>}
                        </p>
                    ) : (
                        filteredGames.map(game => (
                            <div key={game.id} className="p-4 bg-gray-700 rounded-lg flex flex-col sm:flex-row justify-between items-start sm:items-center hover:bg-gray-600 transition duration-150">
                                <div className="mb-2 sm:mb-0">
                                    <p className="text-xl font-semibold text-white">{game.name}</p>
                                    <p className="text-sm text-gray-400">Code: <span className="font-mono text-pink-400">{game.gameCode || 'N/A'}</span> | Players: {game.playerNames.join(', ')}</p>
                                    <p className="text-xs text-gray-500 mt-1">ID: {game.id.substring(0, 8)}...</p>
                                </div>
                                <button
                                    onClick={() => {
                                        setActiveGameId(game.id);
                                        setView('gameplay');
                                    }}
                                    className="px-4 py-2 bg-pink-500 hover:bg-pink-600 rounded-lg font-bold transition duration-150 w-full sm:w-auto"
                                >
                                    {filter === 'active' ? 'Resume' : 'View Leaderboard'}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
});

// 8. Home View
const HomeView = React.memo(({ setView }) => (
    <div className="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center">
        <h2 className="text-3xl font-extrabold mb-8 text-indigo-400">Welcome to Marriage Score Tracker</h2>
        <div className="space-y-4">
            <button
                onClick={() => setView('create')}
                className="w-full py-4 bg-pink-600 hover:bg-pink-700 text-white font-bold text-xl rounded-xl shadow-lg transition duration-150 transform hover:scale-[1.02]"
            >
                + Create New Game
            </button>
            <button
                onClick={() => setView('dashboard')}
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xl rounded-xl shadow-lg transition duration-150 transform hover:scale-[1.02]"
            >
                View Dashboard
            </button>
        </div>
        <p className="text-sm text-gray-500 mt-6">Share a Game ID to play with friends!</p>
    </div>
));


// --- MAIN APP COMPONENT (CONTROLLER) ---

const App = () => {
    // --- FIREBASE AND AUTH STATE ---
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    
    // --- APPLICATION FLOW STATE ---
    const [activeGameId, setActiveGameId] = useState(() => {
        return localStorage.getItem('marriageGameId') || null;
    });
    
    const [view, setView] = useState(() => {
        const persistedId = localStorage.getItem('marriageGameId');
        if (persistedId) return 'gameplay';
        return localStorage.getItem('marriageView') || 'home';
    }); 
    
    const [message, setMessage] = useState('');
    
    // --- GAME DATA STATE (fetched from activeGameId) ---
    const [currentGame, setCurrentGame] = useState(null);
    const [gameHistory, setGameHistory] = useState([]); 
    
    // --- INPUT STATE (for new round entry) ---
    const [showedPlayerIndex, setShowedPlayerIndex] = useState(0);
    const [roundInputs, setRoundInputs] = useState({});
    const [inactivePlayers, setInactivePlayers] = useState([]);
    

    // 0. Persist states to localStorage (Runs on view or activeGameId change)
    useEffect(() => {
        localStorage.setItem('marriageView', view); 

        if (activeGameId) {
            localStorage.setItem('marriageGameId', activeGameId);
        } else {
            localStorage.removeItem('marriageGameId');
        }
    }, [view, activeGameId]);

    // 1. Initialize Firebase and Auth
    useEffect(() => {
        const initializeFirebase = async () => {
            if (!firebaseConfig || !firebaseConfig.projectId || !firebaseConfig.apiKey) {
                 console.error("CRITICAL CONFIGURATION ERROR: Final Firebase config object is incomplete.");
                 setMessage("FATAL ERROR: Incomplete Firebase configuration. Cannot initialize.");
                 setIsAuthReady(true);
                 return;
            }

            try {
                const app = initializeApp(firebaseConfig);
                const authInstance = getAuth(app);
                const dbInstance = getFirestore(app);

                setDb(dbInstance);

                if (initialAuthToken) {
                    await signInWithCustomToken(authInstance, initialAuthToken);
                } else {
                    await signInAnonymously(authInstance);
                }

                onAuthStateChanged(authInstance, (user) => {
                    if (user) {
                        setUserId(user.uid);
                    } else {
                        setUserId(null);
                    }
                    setIsAuthReady(true);
                });
            } catch (error) {
                console.error("FIREBASE INITIALIZATION FAILED:", error);
                setMessage(`FIREBASE ERROR: ${error.code} - Failed to connect or authenticate. Check console for details.`);
                setIsAuthReady(true);
            }
        };
        initializeFirebase();
    }, []);

    // 2. Add Tailwind CSS CDN script dynamically
    useEffect(() => {
        const scriptId = 'tailwind-cdn-script';
        if (!document.getElementById(scriptId)) {
            const script = document.createElement('script');
            script.id = scriptId;
            script.src = 'https://cdn.tailwindcss.com';
            document.head.appendChild(script);
        }
    }, []);

    // 
    //  CSS FIX: This hook injects the viewport meta tag into the document's <head>.
    //  This is CRITICAL for Tailwind's responsive prefixes (sm:, md:, etc.) to work.
    //
    useEffect(() => {
        const viewportMeta = document.querySelector('meta[name="viewport"]');
        if (!viewportMeta) {
            const meta = document.createElement('meta');
            meta.name = 'viewport';
            meta.content = 'width=device-width, initial-scale=1.0';
            document.head.appendChild(meta);
        }
    }, []);


    // 3. Listener for Current Game Configuration
    useEffect(() => {
        if (!db || !isAuthReady || !activeGameId) {
            setCurrentGame(null);
            return;
        }

        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        
        const unsubscribe = onSnapshot(gameDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const gameData = docSnap.data();
                setCurrentGame({ id: docSnap.id, ...gameData });
                
                setRoundInputs({}); 
                setShowedPlayerIndex(0);
                setInactivePlayers([]); 

                setMessage('');
                
                if (view !== 'gameplay') {
                    setView('gameplay');
                }

            } else {
                setMessage("Game not found. Please check the Game ID.");
                setCurrentGame(null);
                setActiveGameId(null); 
                setView('home'); 
            }
        }, (error) => {
            console.error("Error fetching game config:", error);
            setMessage("Error fetching game configuration.");
            setActiveGameId(null); 
            setView('home'); 
        });

        return () => unsubscribe();
    }, [db, isAuthReady, activeGameId, appId]); // 'view' removed to prevent re-subscribing on view change

    // 4. Real-time Listener for Game History (Rounds)
    useEffect(() => {
        if (!db || !isAuthReady || !activeGameId) {
            setGameHistory([]);
            return;
        }

        const roundsCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}/rounds`);
        const q = query(roundsCollectionRef, orderBy('timestamp', 'asc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const rounds = [];
            snapshot.forEach((doc) => {
                rounds.push({ id: doc.id, ...doc.data() });
            });
            setGameHistory(rounds);
        }, (error) => {
            console.error("Error listening to rounds:", error);
        });

        return () => unsubscribe();
    }, [db, isAuthReady, activeGameId, appId]);
    

    // --- Player Status Toggle ---
    const toggleInactive = useCallback((name) => {
        setInactivePlayers(prev => 
            prev.includes(name) 
                ? prev.filter(n => n !== name) // Remove if active
                : [...prev, name] // Add if inactive
        );
        // Reset inputs for the toggled player
        setRoundInputs(prev => ({
             ...prev,
             [name]: { power: '', hands: '' } // Reset to empty string
        }));
    }, [setInactivePlayers, setRoundInputs]);

    // --- Core Calculation Logic ---
    const calculateRoundScores = useCallback((inputs = roundInputs, showedPlayerIdx = showedPlayerIndex, inactiveList = inactivePlayers, pointValue = currentGame?.perPointValue) => {
        if (!currentGame || !pointValue) return {};
        
        const { playerNames } = currentGame;
        
        const activePlayerNames = playerNames.filter(name => !inactiveList.includes(name));
        const numPlayers = activePlayerNames.length;
        
        const showedPlayerName = playerNames[showedPlayerIdx];
        
        const isShowedPlayerActive = activePlayerNames.includes(showedPlayerName);

        if (!isShowedPlayerActive) {
            return playerNames.reduce((acc, name) => ({...acc, [name]: 0}), {});
        }

        const totalPower = activePlayerNames.reduce((sum, name) => sum + (parseFloat(inputs[name]?.power) || 0), 0);
        
        let netValues = 0; 
        const roundScores = {};

        playerNames.forEach((name) => {
            const isActive = activePlayerNames.includes(name);
            const isShowed = name === showedPlayerName;
            
            if (!isActive) {
                roundScores[name] = 0.00;
                return; 
            }

            if (!isShowed) {
                const input = inputs[name] || { power: '', hands: '' };
                const power = parseFloat(input.power) || 0;
                const hands = parseFloat(input.hands) || 0;

                let points = 0;
                
                points -= (totalPower * 20 * pointValue); 
                points -= (hands * 10 * pointValue); 
                points += (power * 20 * numPlayers * pointValue);

                roundScores[name] = parseFloat(points.toFixed(2));
                netValues += points;
            }
        });

        roundScores[showedPlayerName] = parseFloat((-1 * netValues).toFixed(2));
        
        return roundScores;
    }, [currentGame, showedPlayerIndex, roundInputs, inactivePlayers]);


    // --- Aggregate Scores ---
    const totalScores = useMemo(() => {
        if (!currentGame) {
            return [];
        }

        const scoresMap = currentGame.playerNames.reduce((acc, name) => ({ ...acc, [name]: 0 }), {});

        gameHistory.forEach(round => {
            currentGame.playerNames.forEach(name => {
                const score = round.scores[name] || 0; 
                scoresMap[name] += score;
            });
        });
        
        const sortedScores = Object.keys(scoresMap).map(name => ({
            name,
            score: parseFloat(scoresMap[name].toFixed(2))
        })).sort((a, b) => b.score - a.score);

        return sortedScores;

    }, [gameHistory, currentGame]);


    // --- Game Actions (Memoized) ---
    const handleSaveRound = useCallback(async () => {
        if (!db || !userId || !activeGameId || !currentGame || currentGame.status === 'done') {
            setMessage("Cannot save: Game is not active or application is not ready.");
            return;
        }

        const scores = calculateRoundScores();
        
        const showedPlayerName = currentGame.playerNames[showedPlayerIndex];
        if (inactivePlayers.includes(showedPlayerName)) {
            setMessage("Error: The Showed Player cannot be marked as inactive for the round.");
            return;
        }

        const numericalRoundDetails = currentGame.playerNames.reduce((acc, name) => {
            acc[name] = {
                power: parseFloat(roundInputs[name]?.power) || 0,
                hands: parseFloat(roundInputs[name]?.hands) || 0,
            };
            return acc;
        }, {});


        const newRoundData = {
            scores: scores,
            showedPlayer: showedPlayerName,
            inactivePlayers: inactivePlayers,
            perPointValue: currentGame.perPointValue,
            roundDetails: numericalRoundDetails, 
            timestamp: serverTimestamp(),
            savedBy: userId,
        };

        const roundsCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}/rounds`);
        
        try {
            setMessage('Saving round score... ⏳');
            await withBackoff(() => addDoc(roundsCollectionRef, newRoundData));
            
            const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
            await withBackoff(() => updateDoc(gameDocRef, { lastUpdated: serverTimestamp() }));

            setMessage('Round saved successfully! ✅');
            
            setRoundInputs({});
            setShowedPlayerIndex(0);
            setInactivePlayers([]);

        } catch (error) {
            console.error("Error saving round:", error);
            setMessage("Error saving round score. Check console.");
        }
    }, [db, userId, activeGameId, currentGame, calculateRoundScores, showedPlayerIndex, inactivePlayers, roundInputs, appId, setRoundInputs, setShowedPlayerIndex, setInactivePlayers, setMessage]);
    
    const handleMarkDone = useCallback(async () => {
        if (!db || !userId || !activeGameId || currentGame.status === 'done') {
            setMessage("Cannot mark as done: Game is not active.");
            return;
        }

        if (!window.confirm(`Are you sure you want to mark game "${currentGame.name}" as done? This action is usually final.`)) return;

        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        try {
            setMessage('Marking game as done... ⏳');
            await withBackoff(() => updateDoc(gameDocRef, {
                status: 'done',
                finishedAt: serverTimestamp(),
                finalLeaderboard: totalScores 
            }));
            setMessage('Game marked as done. Leaderboard is final. ✅');
        } catch (error) {
            console.error("Error marking game as done:", error);
            setMessage("Error marking game as done. Check console.");
        }
    }, [db, userId, activeGameId, currentGame, totalScores, setMessage, appId]);

    const handleInputChange = useCallback((name, field, value) => {
        // 1. Validation
        if (!/^\d*\.?\d*$/.test(value)) {
            return; 
        }
        
        // 2. Update state
        setRoundInputs(prev => ({
            ...prev,
            [name]: {
                ...(prev[name] || {}), 
                [field]: value 
            }
        }));
    }, [setRoundInputs]); // Stable dependency
    
    const handleAddNewPlayer = useCallback(async (newPlayerName) => {
        if (!db || !userId || !activeGameId || !newPlayerName.trim()) {
            setMessage("Error: Cannot add player. Check name and connection.");
            return;
        }

        const trimmedName = newPlayerName.trim();
        if (currentGame.playerNames.map(n => n.toLowerCase()).includes(trimmedName.toLowerCase())) {
            setMessage(`Error: Player "${trimmedName}" already exists.`);
            return;
        }

        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        const updatedPlayerNames = [...currentGame.playerNames, trimmedName];
        
        try {
            setMessage(`Adding player ${trimmedName}... ⏳`);
            await withBackoff(() => updateDoc(gameDocRef, {
                playerNames: updatedPlayerNames,
                lastUpdated: serverTimestamp(),
            }));
            setMessage(`Player ${trimmedName} added successfully! They can join next round. ✅`);
        } catch (error) {
            console.error("Error adding new player:", error);
            setMessage("Error adding new player. Check console.");
        }
    }, [db, userId, activeGameId, currentGame, setMessage, appId]);

    const handleUpdatePointValue = useCallback(async (newValue) => {
        const numericValue = parseFloat(newValue);
        if (!db || !userId || !activeGameId || isNaN(numericValue) || numericValue <= 0) {
            setMessage("Error: Invalid point value. Must be a positive number.");
            return;
        }

        if (numericValue === currentGame.perPointValue) {
            setMessage("Point value is already set to that amount.");
            return;
        }

        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        
        try {
            setMessage(`Updating point value to $${numericValue.toFixed(2)}... ⏳`);
            await withBackoff(() => updateDoc(gameDocRef, {
                perPointValue: numericValue,
                lastUpdated: serverTimestamp(),
            }));
            setMessage(`Point value updated to $${numericValue.toFixed(2)} for future rounds. ✅`);
        } catch (error) {
            console.error("Error updating point value:", error);
            setMessage("Error updating point value. Check console.");
        }
    }, [db, userId, activeGameId, currentGame, setMessage, appId]);
    
    const handleEditRoundScore = useCallback(async (roundId, updatedRoundDetails) => {
        if (!db || !userId || !activeGameId || !roundId) {
            setMessage("Cannot save edit: Application is not ready.");
            return;
        }
        
        const roundDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}/rounds/${roundId}`);
        
        const { showedPlayerIndex, inactivePlayers, perPointValue } = updatedRoundDetails;
        
        const newScores = calculateRoundScores(
            updatedRoundDetails.rawRoundDetails, // The newly edited raw string hands/power
            showedPlayerIndex,
            inactivePlayers,
            perPointValue
        );
        
        const numericalRoundDetails = currentGame.playerNames.reduce((acc, name) => {
            acc[name] = {
                power: parseFloat(updatedRoundDetails.rawRoundDetails[name]?.power) || 0,
                hands: parseFloat(updatedRoundDetails.rawRoundDetails[name]?.hands) || 0,
            };
            return acc;
        }, {});


        try {
            setMessage('Updating round details and scores... ⏳');
            await withBackoff(() => updateDoc(roundDocRef, {
                scores: newScores,
                roundDetails: numericalRoundDetails,
                showedPlayer: currentGame.playerNames[showedPlayerIndex],
                showedPlayerIndex: showedPlayerIndex,
                inactivePlayers: inactivePlayers,
            }));

            setMessage('Round edited and recalculated successfully! ✅');
            
            const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
            await withBackoff(() => updateDoc(gameDocRef, { lastUpdated: serverTimestamp() }));

        } catch (error) {
            console.error("Error updating round score:", error);
            setMessage("Error updating round score. Check console.");
        }
    }, [db, userId, activeGameId, calculateRoundScores, currentGame, setMessage, appId]);

    
    // --- Main Renderer ---
    const renderContent = () => {
        if (!isAuthReady) {
            return <div className="text-xl animate-pulse text-center p-16">Initializing Application...</div>;
        }

        let content = null;
        switch (view) {
            case 'home':
                content = <HomeView setView={setView} />;
                break;
            case 'create':
                content = (
                    <CreateGameView 
                        db={db}
                        userId={userId}
                        setMessage={setMessage}
                        setActiveGameId={setActiveGameId}
                        setView={setView}
                    />
                );
                break;
            case 'dashboard':
                content = (
                    <DashboardView
                        db={db}
                        isAuthReady={isAuthReady}
                        appId={appId}
                        setMessage={setMessage}
                        setView={setView}
                        setActiveGameId={setActiveGameId}
                    />
                );
                break;
            case 'gameplay':
                content = (
                    <GamePlayView
                        currentGame={currentGame}
                        gameHistory={gameHistory}
                        totalScores={totalScores}
                        message={message}
                        setMessage={setMessage}
                        db={db}
                        handleSaveRound={handleSaveRound}
                        handleMarkDone={handleMarkDone}
                        handleAddNewPlayer={handleAddNewPlayer}
                        handleUpdatePointValue={handleUpdatePointValue}
                        handleEditRoundScore={handleEditRoundScore}
                        calculateRoundScores={calculateRoundScores}
                        inactivePlayers={inactivePlayers}
                        toggleInactive={toggleInactive}
                        showedPlayerIndex={showedPlayerIndex}
                        setShowedPlayerIndex={setShowedPlayerIndex}
                        roundInputs={roundInputs}
                        handleInputChange={handleInputChange}
                    />
                );
                break;
            default:
                content = <HomeView setView={setView} />;
        }
        
        // Wrap centered views in a centering flex container.
        if (view === 'home' || view === 'create' || view === 'dashboard') {
            return (
                <div className="flex justify-center w-full">
                    {content}
                </div>
            );
        }

        // Gameplay view uses its own internal max-width containers
        return content;
    };

    return (
        <div className="min-h-screen h-screen w-full bg-gray-900 text-white p-4 sm:p-8 font-inter overflow-y-auto">
            <style>{`
                .font-inter { font-family: 'Inter', sans-serif; }
            `}</style>
            
            <div className="w-full max-w-5xl mx-auto"> 
                <header className="text-center mb-10 relative">
                    <h1 className="text-4xl font-extrabold text-indigo-400 cursor-pointer" onClick={() => { setView('home'); setActiveGameId(null); }}>
                        Marriage Card Game Tracker
                    </h1>
                    <p className="text-gray-400 mt-1 flex justify-center items-center">
                        <span className="text-sm">Powered by Firestore | User ID: </span>
                        <span className="text-xs font-mono text-pink-400 ml-2">{userId || 'N/A'}</span>
                    </p>
                    {message && (
                        <div className="max-w-4xl mx-auto mt-4 p-3 rounded-lg bg-yellow-900 border border-yellow-500 text-yellow-300">
                            {message}
                        </div>
                    )}
                    {view !== 'home' && (
                        <button
                            onClick={() => {
                                if (view === 'gameplay') {
                                    setActiveGameId(null); 
                                    setView('dashboard');
                                } else {
                                    setView('home'); 
                                }
                            }}
                            className="absolute top-8 left-0 sm:left-4 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition duration-150"
                        >
                            ← Back
                        </button>
                    )}
                </header>

                {renderContent()}
            </div>
        </div>
    );
};

export default App;