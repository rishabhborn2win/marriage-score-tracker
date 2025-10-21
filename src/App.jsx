import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot, orderBy, serverTimestamp, getDocs, addDoc, updateDoc } from 'firebase/firestore';

// --- CONFIGURATION ---
// IMPORTANT: These variables are provided automatically in the Canvas environment.
// For local testing, you must replace the placeholders below with your own Firebase config.

// 🚨 Step 3: This object contains the user's provided configuration.
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

// --- DEFENSIVE CONFIGURATION LOADING ---
let loadedFirebaseConfig = LOCAL_FIREBASE_CONFIG; // Start by trusting the user's provided config

if (!isLocal) {
    try {
        // Attempt to parse the environment's config
        const envConfig = JSON.parse(__firebase_config);
        
        // Only use environment config if it looks valid (has project ID and API key)
        if (envConfig && envConfig.projectId && envConfig.apiKey) {
            loadedFirebaseConfig = envConfig;
        } else {
            // If environment config is invalid, we stick with LOCAL_FIREBASE_CONFIG
            console.warn("Environment Firebase config was invalid or incomplete. Falling back to user-provided config.");
        }
    } catch (e) {
        // If JSON parsing fails, stick with LOCAL_FIREBASE_CONFIG
        console.warn("Failed to parse environment Firebase config. Falling back to user-provided config.", e);
    }
}

const firebaseConfig = loadedFirebaseConfig;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? initialAuthToken : null;
const appId = isLocal ? 'local-test-app' : __app_id; // Using 'local-test-app' as a standard ID for local runs
// --- END DEFENSIVE CONFIGURATION LOADING ---


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
    if (document.execCommand('copy')) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        if (callback) callback();
    }
};

const App = () => {
    // --- FIREBASE AND AUTH STATE ---
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    
    // --- APPLICATION FLOW STATE ---
    const [activeGameId, setActiveGameId] = useState(() => {
        // Load activeGameId from localStorage on initial render
        return localStorage.getItem('marriageGameId') || null;
    });
    
    const [view, setView] = useState(() => {
        const persistedId = localStorage.getItem('marriageGameId');
        if (persistedId) return 'gameplay';
        
        // If no active game, check for persisted view (dashboard/create)
        return localStorage.getItem('marriageView') || 'home';
    }); 
    
    const [message, setMessage] = useState('');
    
    // --- GAME DATA STATE (fetched from activeGameId) ---
    const [currentGame, setCurrentGame] = useState(null);
    const [gameHistory, setGameHistory] = useState([]); 

    // --- INPUT STATE (for new round entry) ---
    const [showedPlayerIndex, setShowedPlayerIndex] = useState(0);
    const [roundInputs, setRoundInputs] = useState({});
    
    // NEW STATE: Tracks which players are inactive for the current round
    const [inactivePlayers, setInactivePlayers] = useState([]);


    // 0. Persist states to localStorage (Runs on view or activeGameId change)
    useEffect(() => {
        // Persist view state for non-gameplay screens
        localStorage.setItem('marriageView', view); 

        // Persist game ID only if a game is active
        if (activeGameId) {
            localStorage.setItem('marriageGameId', activeGameId);
        } else {
            localStorage.removeItem('marriageGameId');
        }
    }, [view, activeGameId]);

    // 1. Initialize Firebase and Auth
    useEffect(() => {
        const initializeFirebase = async () => {
            // Defensive check after configuration loading
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

                // Determine auth method
                if (initialAuthToken) {
                    await signInWithCustomToken(authInstance, initialAuthToken);
                } else {
                    await signInAnonymously(authInstance);
                }

                // Listen for auth state changes
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

    // 2. Add Tailwind CSS CDN script dynamically for environments without build tools
    useEffect(() => {
        // This runs only once when the component mounts.
        // It ensures Tailwind loads if it's not pre-included (e.g., in a local, single-file setup).
        const scriptId = 'tailwind-cdn-script';
        if (!document.getElementById(scriptId)) {
            const script = document.createElement('script');
            script.id = scriptId;
            script.src = 'https://cdn.tailwindcss.com';
            document.head.appendChild(script);
        }
    }, []);

    // 3. Listener for Current Game Configuration (runs when activeGameId changes)
    useEffect(() => {
        if (!db || !isAuthReady || !activeGameId) {
            setCurrentGame(null);
            return;
        }

        // Firestore path to the specific game document
        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        
        const unsubscribe = onSnapshot(gameDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const gameData = docSnap.data();
                setCurrentGame({ id: docSnap.id, ...gameData });
                
                // Initialize round inputs based on player names
                const newInputs = gameData.playerNames.reduce((acc, name) => ({
                    ...acc,
                    [name]: { power: 0, hands: 0 }
                }), {});
                setRoundInputs(newInputs);
                
                // Reset showed player and inactive list when game data loads
                setShowedPlayerIndex(0);
                setInactivePlayers([]); 

                setMessage('');
                
                // Ensure view is set to gameplay if data is successfully loaded
                if (view !== 'gameplay') {
                    setView('gameplay');
                }

            } else {
                setMessage("Game not found. Please check the Game ID.");
                setCurrentGame(null);
                setActiveGameId(null); // Clear ID if game vanishes
                setView('home'); // Go home if game is not found
            }
        }, (error) => {
            console.error("Error fetching game config:", error);
            setMessage("Error fetching game configuration.");
            setActiveGameId(null); // Clear ID on error
            setView('home'); // Go home on error
        });

        return () => unsubscribe();
    }, [db, isAuthReady, activeGameId, appId]);

    // 4. Real-time Listener for Game History (Rounds)
    useEffect(() => {
        if (!db || !isAuthReady || !activeGameId) {
            setGameHistory([]);
            return;
        }

        // Firestore path to the rounds subcollection
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
    const toggleInactive = (name) => {
        setInactivePlayers(prev => 
            prev.includes(name) 
                ? prev.filter(n => n !== name) // Remove if active
                : [...prev, name]             // Add if inactive
        );
        // Reset inputs for the toggled player just in case
        setRoundInputs(prev => ({
             ...prev,
             [name]: { power: 0, hands: 0 }
        }));
    };

    // --- Core Calculation Logic ---
    const calculateRoundScores = useCallback(() => {
        if (!currentGame) return {};

        const { playerNames, perPointValue } = currentGame;
        
        // Filter out inactive players for this round's calculation
        const activePlayerNames = playerNames.filter(name => !inactivePlayers.includes(name));
        const numPlayers = activePlayerNames.length;
        
        // Find the index of the showed player within the FULL playerNames list
        const showedPlayerName = playerNames[showedPlayerIndex];
        
        // Check if the showed player is active
        const isShowedPlayerActive = activePlayerNames.includes(showedPlayerName);

        // If the intended showed player is inactive, we can't calculate a valid round.
        if (!isShowedPlayerActive) {
            // Assign 0 to all players and return (or handle error)
            return playerNames.reduce((acc, name) => ({...acc, [name]: 0}), {});
        }

        // Calculate total power contributed by active players
        const totalPower = activePlayerNames.reduce((sum, name) => sum + (roundInputs[name]?.power || 0), 0);
        
        let netValues = 0; // Tracks the total loss incurred by non-showed, active players
        const roundScores = {};

        playerNames.forEach((name) => {
            const isActive = activePlayerNames.includes(name);
            const isShowed = name === showedPlayerName;
            
            // Inactive players always score 0 for the round
            if (!isActive) {
                roundScores[name] = 0.00;
                return; 
            }

            const input = roundInputs[name] || { power: 0, hands: 0 };
            const power = input.power;
            const hands = input.hands;
            let points = 0;

            if (!isShowed) {
                // Non-Showed, Active Player calculation (following original Python logic)
                
                // Loss component 1: Loss due to total power in the game
                points -= (totalPower * 20 * perPointValue); 
                
                // Loss component 2: Loss due to hands taken
                points -= (hands * 10 * perPointValue); 
                
                // Gain component: Gain due to own power * number of active players (since only active players pay/gain)
                points += (power * 20 * numPlayers * perPointValue);

                roundScores[name] = parseFloat(points.toFixed(2));
                netValues += points;
            }
        });

        // Showed Player calculation: Wins the total amount lost by active others
        roundScores[showedPlayerName] = parseFloat((-1 * netValues).toFixed(2));
        
        return roundScores;
    }, [currentGame, showedPlayerIndex, roundInputs, inactivePlayers]);
    // --- End of Calculation Logic ---


    // --- Aggregate Scores ---
    const totalScores = useMemo(() => {
        if (!currentGame) {
            return [];
        }

        const scoresMap = currentGame.playerNames.reduce((acc, name) => ({ ...acc, [name]: 0 }), {});

        gameHistory.forEach(round => {
            currentGame.playerNames.forEach(name => {
                // Safely access score, defaulting to 0 if not present
                const score = round.scores[name] || 0; 
                scoresMap[name] += score;
            });
        });

        const sortedScores = Object.keys(scoresMap).map(name => ({
            name,
            score: parseFloat(scoresMap[name].toFixed(2))
        })).sort((a, b) => b.score - a.score); // Sort for leaderboard

        return sortedScores;

    }, [gameHistory, currentGame]);


    // --- Game Actions ---
    const handleSaveRound = async () => {
        if (!db || !userId || !activeGameId || !currentGame || currentGame.status === 'done') {
            setMessage("Cannot save: Game is not active or application is not ready.");
            return;
        }

        const scores = calculateRoundScores();
        
        // Basic check to ensure the showed player wasn't inactive
        const showedPlayerName = currentGame.playerNames[showedPlayerIndex];
        if (inactivePlayers.includes(showedPlayerName)) {
            setMessage("Error: The Showed Player cannot be marked as inactive for the round.");
            return;
        }

        const newRoundData = {
            scores: scores,
            showedPlayer: showedPlayerName,
            inactivePlayers: inactivePlayers, // Save inactive list for historical context
            perPointValue: currentGame.perPointValue,
            roundDetails: roundInputs, // Store all inputs (active and inactive 0s)
            timestamp: serverTimestamp(),
            savedBy: userId,
        };

        const roundsCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}/rounds`);
        
        try {
            setMessage('Saving round score... ⏳');
            await withBackoff(() => addDoc(roundsCollectionRef, newRoundData));
            
            // Also update the parent document's lastUpdated field
            const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
            await withBackoff(() => updateDoc(gameDocRef, { lastUpdated: serverTimestamp() }));

            setMessage('Round saved successfully! ✅');
            
            // Clear inputs and reset state for next round
            const newInputs = currentGame.playerNames.reduce((acc, name) => ({
                ...acc,
                [name]: { power: 0, hands: 0 }
            }), {});
            setRoundInputs(newInputs);
            setShowedPlayerIndex(0);
            setInactivePlayers([]); // Reset inactive players for the next round

        } catch (error) {
            console.error("Error saving round:", error);
            setMessage("Error saving round score. Check console.");
        }
    };
    
    const handleMarkDone = async () => {
        if (!db || !userId || !activeGameId || currentGame.status === 'done') {
            setMessage("Cannot mark as done: Game is not active.");
            return;
        }

        // Using a simple modal UI instead of window.confirm
        if (!window.confirm(`Are you sure you want to mark game "${currentGame.name}" as done? This action is usually final.`)) return;

        const gameDocRef = doc(db, `artifacts/${appId}/public/data/marriage_games/${activeGameId}`);
        try {
            setMessage('Marking game as done... ⏳');
            // The finalLeaderboard is calculated based on current totalScores and saved once.
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
    };

    const handleInputChange = (name, field, value) => {
        // Ensure inputs are non-negative integers
        const numericValue = Math.max(0, parseInt(value, 10) || 0); 
        setRoundInputs(prev => ({
            ...prev,
            [name]: {
                ...prev[name],
                [field]: numericValue
            }
        }));
    };
    
    // --- New Feature: Add Player Logic ---
    const handleAddNewPlayer = async (newPlayerName) => {
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
    };

    // --- Components / Views ---

    // 5. GamePlay View
    const GamePlayView = () => {
        const [newPlayerName, setNewPlayerName] = useState(''); // State for new player input

        if (!currentGame) {
            return <div className="text-center text-xl text-yellow-400 p-8">Loading game details...</div>;
        }
        
        const isGameDone = currentGame.status === 'done';
        const previewScores = calculateRoundScores();
        
        const activePlayerNames = currentGame.playerNames.filter(name => !inactivePlayers.includes(name));

        return (
            <>
                {/* Game Info and Share ID */}
                <div className="max-w-4xl w-full mx-auto bg-gray-700 p-4 rounded-xl shadow-inner mb-6">
                    <h2 className="text-2xl font-bold text-indigo-200">{currentGame.name}</h2>
                    <p className="text-sm text-gray-400">Point Value: ${currentGame.perPointValue.toFixed(2)}</p>
                    <div className="flex items-center justify-between mt-2 p-2 bg-gray-800 rounded-lg">
                        <span className="text-sm font-mono text-pink-400 select-all">
                            Game Code: {currentGame.gameCode}
                            <span className="ml-4 text-xs text-gray-500">({currentGame.id.substring(0, 8)}...)</span>
                        </span>
                        <button
                            onClick={() => copyToClipboard(currentGame.gameCode, () => setMessage('Game Code copied!'))}
                            className="text-xs px-3 py-1 bg-indigo-500 hover:bg-indigo-600 rounded-lg transition duration-150"
                        >
                            Copy Code
                        </button>
                    </div>
                </div>
                
                {/* NEW: Add Player Section */}
                {!isGameDone && (
                    <div className="max-w-4xl w-full mx-auto bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
                         <h3 className="text-xl font-bold mb-4 border-b border-gray-700 pb-2 text-pink-300">Add New Player</h3>
                         <div className="flex space-x-3">
                             <input
                                 type="text"
                                 value={newPlayerName}
                                 onChange={(e) => setNewPlayerName(e.target.value)}
                                 placeholder="Enter new player's name"
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
                         {currentGame.playerNames.length >= 8 && <p className="text-sm text-yellow-400 mt-2">Maximum 8 players reached.</p>}
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
                                            className={`flex items-center px-4 py-2 rounded-full font-semibold text-sm transition duration-150 ${
                                                isInactive 
                                                    ? 'bg-gray-600 text-gray-300 hover:bg-gray-500' 
                                                    : 'bg-green-600 text-white hover:bg-green-700'
                                            }`}
                                        >
                                            {name}
                                            <span className="ml-2 text-xs">
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
                        
                        {/* Individual Player Inputs (Only for Active Players) */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {activePlayerNames.map((name) => {
                                const index = currentGame.playerNames.indexOf(name);
                                const isShowed = index === showedPlayerIndex;
                                const input = roundInputs[name] || { power: 0, hands: 0 };
                                
                                return (
                                    <div key={index} className={`p-4 rounded-lg transition duration-150 ${isShowed ? 'bg-indigo-900 border border-indigo-500 shadow-md' : 'bg-gray-700 border border-gray-600'}`}>
                                        <h4 className="font-bold text-lg mb-2 flex justify-between items-center">
                                            {name} 
                                            {isShowed && <span className="text-xs px-2 py-0.5 bg-indigo-500 rounded-full">SHOWED</span>}
                                        </h4>
                                        
                                        {/* Power Input (for all active) */}
                                        <div className="mb-3">
                                            <label className="block text-sm text-gray-400 mb-1">Power ({name})</label>
                                            <input
                                                type="number"
                                                min="0"
                                                value={input.power}
                                                onChange={(e) => handleInputChange(name, 'power', e.target.value)}
                                                className="w-full p-2 rounded bg-gray-800 border border-gray-600 focus:ring-pink-500 focus:border-pink-500"
                                            />
                                        </div>
                                        
                                        {/* Hands Input (only for non-showed active) */}
                                        {!isShowed && (
                                            <div>
                                                <label className="block text-sm text-gray-400 mb-1">Hands ({name})</label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    value={input.hands}
                                                    onChange={(e) => handleInputChange(name, 'hands', e.target.value)}
                                                    className="w-full p-2 rounded bg-gray-800 border border-gray-600 focus:ring-pink-500 focus:border-pink-500"
                                                />
                                            </div>
                                        )}
                                    </div>
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
                
                {/* Score History and Leaderboard */}
                <div className="max-w-4xl w-full mx-auto bg-gray-800 p-6 rounded-xl shadow-2xl">
                    <h2 className="text-2xl font-bold mb-4 border-b border-gray-700 pb-2 text-indigo-300">
                        {isGameDone ? 'Final Leaderboard' : 'Current Scoreboard'}
                    </h2>
                    
                    {/* Leaderboard Table */}
                    <div className="mb-6">
                        <div className="flex justify-between items-center py-2 px-3 bg-gray-700 rounded-t-lg font-bold text-sm text-gray-300">
                            <span className="w-1/3">Rank</span>
                            <span className="w-1/3 text-left">Player</span>
                            <span className="w-1/3 text-right">Score</span>
                        </div>
                        {totalScores.map((player, index) => (
                            <div key={player.name} className={`flex justify-between items-center p-3 border-b border-gray-700 ${index % 2 === 0 ? 'bg-gray-800' : 'bg-gray-700/50'}`}>
                                <span className="w-1/3 text-lg font-extrabold text-indigo-400">#{index + 1}</span>
                                <span className="w-1/3 text-lg font-semibold">{player.name}</span>
                                <span className={`w-1/3 text-lg font-extrabold text-right ${player.score >= 0 ? 'text-green-400' : 'text-red-400'}`}>
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
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-700">
                                    <thead className="bg-gray-700">
                                        <tr>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider rounded-tl-lg"># / Showed</th>
                                            {currentGame.playerNames.map((name, index) => (
                                                <th key={index} className="px-3 py-3 text-center text-xs font-medium text-gray-300 uppercase tracking-wider">
                                                    {name}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {gameHistory.map((round, roundIndex) => (
                                            <tr key={round.id} className="hover:bg-gray-700/50 transition duration-100">
                                                <td className="px-3 py-3 whitespace-nowrap text-sm font-medium text-gray-300">
                                                    #{roundIndex + 1}
                                                    <span className="block text-xs text-indigo-400">({round.showedPlayer})</span>
                                                    {round.inactivePlayers && round.inactivePlayers.length > 0 && (
                                                        <span className="block text-xs text-yellow-400">({round.inactivePlayers.join(', ')} inactive)</span>
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
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            </>
        );
    };

    // 6. CreateGame View
    const CreateGameView = () => {
        const [gameName, setGameName] = useState('');
        const [numPlayers, setNumPlayers] = useState(3);
        const [perPointValue, setPerPointValue] = useState(0.5);
        const [playerNamesInput, setPlayerNamesInput] = useState(['Rishabh', 'Friend 1', 'Friend 2']);

        useEffect(() => {
            // Adjust player name array length when numPlayers changes
            const newNames = Array.from({ length: numPlayers }, (_, i) => playerNamesInput[i] || `Player ${i + 1}`);
            setPlayerNamesInput(newNames);
        }, [numPlayers]);
        
        const handleCreate = async () => {
            if (!db || !userId || !gameName || playerNamesInput.slice(0, numPlayers).some(name => name.trim() === '')) {
                setMessage("Please fill in a game name and all player names.");
                return;
            }

            // --- NEW: Generate readable code ---
            const gameCode = generateGameCode();

            const newGameData = {
                name: gameName,
                perPointValue: parseFloat(perPointValue),
                playerNames: playerNamesInput.slice(0, numPlayers).filter(name => name.trim() !== ''),
                status: 'active', // 'active' or 'done'
                createdAt: serverTimestamp(),
                createdBy: userId,
                lastUpdated: serverTimestamp(),
                finalLeaderboard: null,
                gameCode: gameCode, // Stored for searching/sharing
            };

            const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games`);

            try {
                setMessage('Creating new game... ⏳');
                const docRef = await withBackoff(() => addDoc(gamesCollectionRef, newGameData));
                
                // Navigate to the newly created game
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
    };

    // 7. Dashboard View
    const DashboardView = () => {
        const [gamesList, setGamesList] = useState([]);
        const [filter, setFilter] = useState('active'); // 'active' or 'done'
        const [loading, setLoading] = useState(true);
        const [searchQuery, setSearchQuery] = useState(''); // NEW: Search state

        useEffect(() => {
            if (!db || !isAuthReady) return;

            setLoading(true);
            const gamesCollectionRef = collection(db, `artifacts/${appId}/public/data/marriage_games`);
            
            // Query to get all games, ordered by last updated date
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
        }, [db, isAuthReady, appId]);

        const filteredGames = gamesList.filter(game => {
            // Apply status filter
            const statusMatch = game.status === filter;
            
            // Apply search filter (case-insensitive check against name and gameCode)
            const searchLower = searchQuery.toLowerCase();
            const searchMatch = game.name.toLowerCase().includes(searchLower) ||
                                (game.gameCode && game.gameCode.toLowerCase().includes(searchLower));

            return statusMatch && searchMatch;
        });
        
        return (
            <div className="max-w-4xl w-full bg-gray-800 p-6 rounded-xl shadow-2xl mb-8">
                <h2 className="text-3xl font-bold mb-6 text-pink-300">Game Dashboard</h2>
                
                {/* NEW: Search Input */}
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
                                <div key={game.id} className="p-4 bg-gray-700 rounded-lg flex justify-between items-center hover:bg-gray-600 transition duration-150">
                                    <div>
                                        <p className="text-xl font-semibold text-white">{game.name}</p>
                                        <p className="text-sm text-gray-400">Code: <span className="font-mono text-pink-400">{game.gameCode || 'N/A'}</span> | Players: {game.playerNames.join(', ')}</p>
                                        <p className="text-xs text-gray-500 mt-1">ID: {game.id.substring(0, 8)}...</p>
                                    </div>
                                    <button
                                        onClick={() => {
                                            setActiveGameId(game.id);
                                            setView('gameplay');
                                        }}
                                        className="px-4 py-2 bg-pink-500 hover:bg-pink-600 rounded-lg font-bold transition duration-150"
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
    };

    // 8. Home View
    const HomeView = () => (
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
    );
    
    // --- Main Renderer ---
    const renderContent = () => {
        if (!isAuthReady) {
            return <div className="text-xl animate-pulse text-center p-16">Initializing Application...</div>;
        }

        let content = null;
        switch (view) {
            case 'home':
                content = <HomeView />;
                break;
            case 'create':
                content = <CreateGameView />;
                break;
            case 'dashboard':
                content = <DashboardView />;
                break;
            case 'gameplay':
                content = <GamePlayView />;
                break;
            default:
                content = <HomeView />;
        }
        
        // Wrap centered views (Home, Create, Dashboard) in a centering flex container.
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
            {/* Tailwind CSS classes are assumed to be loaded by the environment. */}
            {/* Custom styles for appearance tweaks: */}
            <style>{`
                .font-inter { font-family: 'Inter', sans-serif; }
                input[type="number"]::-webkit-inner-spin-button, 
                input[type="number"]::-webkit-outer-spin-button { 
                    -webkit-appearance: none; 
                    margin: 0; 
                }
                input[type="number"] {
                    -moz-appearance: textfield;
                }
            `}</style>
            
            {/* Outer wrapper for header and content */}
            <div className="w-full max-w-5xl mx-auto"> 
                <header className="text-center mb-10 relative">
                    <h1 className="text-4xl font-extrabold text-indigo-400 cursor-pointer" onClick={() => { setView('home'); setActiveGameId(null); }}>
                        Marriage Card Game Tracker
                    </h1>
                    <p className="text-gray-400 mt-1 flex justify-center items-center">
                        <span className="text-sm">Powered by Firestore | User ID: </span>
                        <span className="text-xs font-mono text-pink-400 ml-2">{userId || 'N/A'}</span>
                    </p>
                    {/* Global Message Box */}
                    {message && (
                        <div className="max-w-4xl mx-auto mt-4 p-3 rounded-lg bg-yellow-900 border border-yellow-500 text-yellow-300">
                            {message}
                        </div>
                    )}
                    {/* Back Button for views other than Home */}
                    {view !== 'home' && (
                        <button
                            onClick={() => {
                                if (view === 'gameplay') {
                                    setActiveGameId(null); // Clears local storage state for active game
                                    setView('dashboard');
                                } else {
                                    // For create/dashboard view, just go back to home
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