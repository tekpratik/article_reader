import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    SafeAreaView,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from 'react-native';
import RenderHTML from 'react-native-render-html';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';

const ELEVEN_API_KEY = ''; // 🔴 ADD YOUR KEY
const VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

// Max chars per TTS chunk — stay well under ElevenLabs' 5000 char limit
// and keep chunks at natural paragraph breaks
const MAX_CHUNK_CHARS = 2000;

// ─────────────────────────────────────────────
//  PARSING PIPELINE
// ─────────────────────────────────────────────

/**
 * Strips Medium / Jina noise from raw fetched text.
 * Returns { title, author, readingTime, bodyLines }
 */
function parseMediumContent(raw: string): {
    title: string;
    author: string;
    readingTime: string;
    bodyLines: string[];
} {
    const lines = raw
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    // ── Discard known boilerplate patterns ──────────────────────────────
    const boilerplatePatterns = [
        /^(sign\s*in|sign\s*up|get\s*started|subscribe|follow|unfollow|membership|upgrade|open\s*in\s*app)/i,
        /^(responses?|claps?|share|save|more|listen|related\s*stories?)/i,
        /^\d+\s*(claps?|responses?|min\s*read)/i,
        /^(published\s*in|written\s*by|about\s*the\s*author)/i,
        /^(·\s*\d+\s*min\s*read)/i,
        /^(help|status|about|careers|press|blog|privacy|terms|text\s*to\s*speech|teams)/i,
        /^https?:\/\//i,          // bare URLs
        /^\[.*?\]\(.*?\)$/,        // markdown image/link-only lines
        /^!\[.*?\]/,               // markdown images
        /^-{3,}$/,                 // horizontal rules
        /^#{1,6}\s*$/,             // empty headings
        /^\*{1,3}$/,               // lone asterisks
        /^>{1,}/,                  // blockquotes from Jina artefacts
        /^\|.*\|$/,                // markdown table rows
    ];

    const isBoilerplate = (line: string) =>
        boilerplatePatterns.some(p => p.test(line)) ||
        line.length < 4;

    // ── Extract metadata from first ~20 lines ───────────────────────────
    let title = '';
    let author = '';
    let readingTime = '';
    const metaSearchLines = lines.slice(0, 25);

    for (const line of metaSearchLines) {
        if (!title && line.length > 10 && /^#/.test(line)) {
            title = line.replace(/^#+\s*/, '').trim();
        }
        const authorMatch = line.match(/^by\s+(.+)$/i);
        if (!author && authorMatch) author = authorMatch[1].trim();

        const rtMatch = line.match(/(\d+)\s*min\s*read/i);
        if (!readingTime && rtMatch) readingTime = `${rtMatch[1]} minute read`;
    }

    // Fallback: first non-boilerplate line is the title
    if (!title) {
        const firstReal = lines.find(l => !isBoilerplate(l) && l.length > 15);
        title = firstReal?.replace(/^#+\s*/, '') ?? 'Article';
    }

    // ── Build body ───────────────────────────────────────────────────────
    // Skip lines until we're past the metadata header block
    let bodyStart = 0;
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
        if (
            lines[i].replace(/^#+\s*/, '').trim() === title.trim() ||
            /^\d+\s*min\s*read/i.test(lines[i])
        ) {
            bodyStart = i + 1;
        }
    }

    const bodyLines = lines
        .slice(bodyStart)
        .filter(l => !isBoilerplate(l))
        // Strip leftover markdown heading markers but keep heading text
        .map(l => l.replace(/^#{1,6}\s+/, ''))
        // Strip markdown bold/italic
        .map(l => l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1'))
        // Strip inline markdown links, keep text
        .map(l => l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
        // Remove backtick code spans (code doesn't TTS well)
        .map(l => l.replace(/`[^`]+`/g, ''))
        .filter(Boolean);

    return { title, author, readingTime, bodyLines };
}

/**
 * Normalises text so ElevenLabs reads it naturally.
 */
function normaliseTTS(text: string): string {
    return text
        // Em-dash / en-dash → pause
        .replace(/\s*[—–]\s*/g, ', ')
        // Ellipsis → pause
        .replace(/\.{2,}/g, '...')
        // Straight quotes → readable
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        // Common abbreviations
        .replace(/\be\.g\./gi, 'for example')
        .replace(/\bi\.e\./gi, 'that is')
        .replace(/\betc\./gi, 'et cetera')
        .replace(/\bvs\./gi, 'versus')
        .replace(/\bapprox\./gi, 'approximately')
        .replace(/\bdr\./gi, 'Doctor')
        .replace(/\bmr\./gi, 'Mister')
        .replace(/\bms\./gi, 'Miss')
        // Numbers: 1st, 2nd…
        .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1$2')
        // Remove leftover markdown symbols
        .replace(/[#*_~`|]/g, '')
        // Collapse multiple spaces
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Splits normalised body text into TTS-friendly chunks.
 * Chunks break at paragraph boundaries first, then sentence boundaries,
 * never in the middle of a sentence.
 */
function buildTTSChunks(
    title: string,
    author: string,
    readingTime: string,
    bodyLines: string[]
): string[] {
    // Podcast-style opening
    const intro = author
        ? `${title}. By ${author}.${readingTime ? ` ${readingTime}.` : ''}`
        : `${title}.`;

    const paragraphs = bodyLines.map(normaliseTTS).filter(Boolean);

    const chunks: string[] = [normaliseTTS(intro)];
    let current = '';

    for (const para of paragraphs) {
        // If adding this paragraph would exceed the limit, flush first
        if (current.length + para.length + 2 > MAX_CHUNK_CHARS && current.length > 0) {
            chunks.push(current.trim());
            current = '';
        }

        // Paragraph itself is longer than the limit — split on sentences
        if (para.length > MAX_CHUNK_CHARS) {
            const sentences = para.match(/[^.!?]+[.!?]+["']?\s*/g) ?? [para];
            for (const sentence of sentences) {
                if (current.length + sentence.length > MAX_CHUNK_CHARS && current.length > 0) {
                    chunks.push(current.trim());
                    current = '';
                }
                current += sentence;
            }
        } else {
            current += (current ? ' ' : '') + para;
        }
    }

    if (current.trim()) chunks.push(current.trim());

    return chunks.filter(c => c.length > 0);
}

// ─────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────

const App: React.FC = () => {
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [readingTime, setReadingTime] = useState('');
    const [bodyLines, setBodyLines] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [currentChunk, setCurrentChunk] = useState(0);
    const [totalChunks, setTotalChunks] = useState(0);
    const [error, setError] = useState('');

    const soundRef = useRef<Sound | null>(null);
    const stopRef = useRef(false);
    const { width } = useWindowDimensions();

    useEffect(() => {
        Sound.setCategory('Playback');
        return () => { stopSpeech(); };
    }, []);

    // ── Stop ──────────────────────────────────────────────────────────────
    const stopSpeech = async () => {
        stopRef.current = true;
        if (soundRef.current) {
            soundRef.current.stop(() => {
                soundRef.current?.release();
                soundRef.current = null;
            });
        }
        setIsSpeaking(false);
        setCurrentChunk(0);
        setTotalChunks(0);
    };

    // ── Fetch one chunk from ElevenLabs ──────────────────────────────────
    const fetchAudio = async (text: string): Promise<string> => {
        const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': ELEVEN_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text,
                    model_id: 'eleven_flash_v2_5',
                    voice_settings: {
                        stability: 0.45,        // slight variation = more natural
                        similarity_boost: 0.80,
                        style: 0.30,            // expressive
                        use_speaker_boost: true,
                    },
                }),
            }
        );

        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`TTS error ${res.status}: ${errBody}`);
        }

        const blob = await res.blob();
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
        });
    };

    // ── Play chunks sequentially ─────────────────────────────────────────
    const playChunks = async (chunks: string[]) => {
        stopRef.current = false;
        setIsSpeaking(true);
        setTotalChunks(chunks.length);

        for (let i = 0; i < chunks.length; i++) {
            if (stopRef.current) break;
            setCurrentChunk(i + 1);

            const base64 = await fetchAudio(chunks[i]);
            const path = `${RNFS.CachesDirectoryPath}/tts_${i}.mp3`;
            await RNFS.writeFile(path, base64, 'base64');

            await new Promise<void>((resolve) => {
                const sound = new Sound(path, '', (e) => {
                    if (e) return resolve();
                    soundRef.current = sound;
                    sound.play(() => {
                        sound.release();
                        soundRef.current = null;
                        resolve();
                    });
                });
            });
        }

        setIsSpeaking(false);
        setCurrentChunk(0);
        setTotalChunks(0);
    };

    // ── Play handler ─────────────────────────────────────────────────────
    const playSpeech = async () => {
        if (!bodyLines.length) { setError('Load an article first'); return; }
        if (!ELEVEN_API_KEY) { setError('Add your ElevenLabs API key'); return; }

        await stopSpeech();

        try {
            const chunks = buildTTSChunks(title, author, readingTime, bodyLines);
            playChunks(chunks);
        } catch (e: any) {
            setError(e.message);
            setIsSpeaking(false);
        }
    };

    // ── Load article ─────────────────────────────────────────────────────
    const loadArticle = async () => {
        const trimmed = url.trim();
        if (!trimmed.startsWith('http')) { setError('Enter a valid URL'); return; }

        setIsLoading(true);
        setError('');
        setTitle('');
        setAuthor('');
        setReadingTime('');
        setBodyLines([]);
        await stopSpeech();

        try {
            // Jina reader strips HTML; we get clean markdown-ish text
            const jinaUrl = `https://r.jina.ai/${trimmed}`;
            const res = await fetch(jinaUrl, {
                headers: { 'Accept': 'text/plain' },
            });

            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            const raw = await res.text();

            const parsed = parseMediumContent(raw);
            setTitle(parsed.title);
            setAuthor(parsed.author);
            setReadingTime(parsed.readingTime);
            setBodyLines(parsed.bodyLines);
        } catch (e: any) {
            setError(e.message);
        }

        setIsLoading(false);
    };

    // ── HTML for display ──────────────────────────────────────────────────
    const htmlContent = useMemo(() => {
        if (!bodyLines.length) return '';
        const paras = bodyLines
            .map(l => `<p>${l.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
            .join('');
        return `<div><h1>${title}</h1>${author ? `<p><em>By ${author}</em></p>` : ''}${paras}</div>`;
    }, [bodyLines, title, author]);

    const hasContent = bodyLines.length > 0;
    const progressText = isSpeaking && totalChunks > 0
        ? `Playing part ${currentChunk} of ${totalChunks}`
        : '';

    return (
        <SafeAreaView style={styles.safe}>
            <StatusBar barStyle="dark-content" />
            <View style={styles.container}>
                <Text style={styles.heading}>📰 Smart Reader</Text>

                <TextInput
                    placeholder="Paste Medium article URL..."
                    value={url}
                    onChangeText={setUrl}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                />

                <TouchableOpacity
                    style={[styles.btn, isLoading && styles.btnDisabled]}
                    onPress={loadArticle}
                    disabled={isLoading}
                >
                    {isLoading
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.btnText}>Load Article</Text>}
                </TouchableOpacity>

                {hasContent && (
                    <View style={styles.row}>
                        <TouchableOpacity
                            style={[styles.btn2, isSpeaking && styles.btn2Active]}
                            onPress={isSpeaking ? undefined : playSpeech}
                            disabled={isSpeaking}
                        >
                            <Text style={styles.btn2Text}>
                                {isSpeaking ? '▶ Playing' : '▶ Listen'}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.btn2} onPress={stopSpeech}>
                            <Text style={styles.btn2Text}>■ Stop</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {progressText ? (
                    <Text style={styles.progress}>{progressText}</Text>
                ) : null}

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <ScrollView style={styles.article} showsVerticalScrollIndicator={false}>
                    {hasContent ? (
                        <RenderHTML contentWidth={width} source={{ html: htmlContent }} />
                    ) : (
                        <Text style={styles.placeholder}>
                            Paste a Medium article URL above and tap Load Article.
                        </Text>
                    )}
                </ScrollView>
            </View>
        </SafeAreaView>
    );
};

// ─────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: '#f4f6fb' },
    container: { flex: 1, padding: 16 },
    heading: { fontSize: 24, fontWeight: 'bold', marginBottom: 4 },

    input: {
        borderWidth: 1,
        borderColor: '#d0d5dd',
        padding: 12,
        marginTop: 10,
        borderRadius: 8,
        backgroundColor: '#fff',
        fontSize: 15,
    },

    btn: {
        backgroundColor: '#007AFF',
        padding: 14,
        marginTop: 10,
        borderRadius: 8,
        alignItems: 'center',
    },
    btnDisabled: { backgroundColor: '#99c4f8' },
    btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },

    row: { flexDirection: 'row', marginTop: 10, gap: 8 },

    btn2: {
        flex: 1,
        padding: 14,
        backgroundColor: '#fff',
        alignItems: 'center',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#d0d5dd',
    },
    btn2Active: { backgroundColor: '#e8f2ff', borderColor: '#007AFF' },
    btn2Text: { fontWeight: '600', color: '#1a1a2e' },

    progress: {
        marginTop: 8,
        textAlign: 'center',
        color: '#007AFF',
        fontSize: 13,
    },

    article: {
        marginTop: 12,
        backgroundColor: '#fff',
        padding: 14,
        borderRadius: 8,
        flex: 1,
    },

    placeholder: {
        color: '#888',
        textAlign: 'center',
        marginTop: 40,
        fontSize: 15,
        lineHeight: 24,
    },

    error: { color: '#d00', marginTop: 8, fontSize: 14 },
});

export default App;
