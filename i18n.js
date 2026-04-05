/**
 * Internationalization Module
 * Handles multi-language support (EN, FR, ES)
 */

const i18n = {
    currentLang: 'en',

    translations: {
        en: {
            // App title
            appTitle: 'OpenModelica Result Viewer',

            // Top bar
            variables: 'Variables',
            layout: 'Layout Configuration',
            options: 'Options',
            rows: 'Rows',
            columns: 'Columns',
            apply: 'Apply',
            showDescriptions: 'Show descriptions',
            linkTimeAxes: 'Link time axes',
            syncHover: 'Synchronized hover',

            // Drop zone
            dragFile: 'Drag & drop a .mat file here',
            or: 'or',
            selectFile: 'Select File',

            // Messages
            fileLoaded: 'File loaded successfully',
            errorLoading: 'Error loading file',
            invalidFile: 'Invalid .mat file',

            // Tree
            component: 'Component',
            variable: 'Variable',
            parameter: 'Parameter',

            // Tooltips
            toggleSidebar: 'Toggle sidebar',
            autoZoom: 'Auto-fit all plots',
            clearPlots: 'Clear all plots',
            reloadFile: 'Reload file',
            toggleTheme: 'Toggle theme',
            loadNewFile: 'Load new file',
            toggleDescriptions: 'Toggle descriptions',
            expandAll: 'Expand all',
            collapseAll: 'Collapse all',
            resetLayout: 'Reset layout',
            help: 'Help',
            loadExample: 'Load example',
            loadExampleWarning: 'Loading the example will reset the current layout and clear all plots. Loaded files will remain. Continue?',
            files: 'Files',
            closeFile: 'Remove file',
            closeFileWarning: 'This file has plots loaded. Removing it will delete those plots. Continue?',

            // Layout panels
            layout: 'Layout',
            layoutHint: 'Hover a panel to reveal split (◀▶ / ▲▼) and close (✕) buttons.',
            splitRight: 'Add panel to the right',
            splitLeft: 'Add panel to the left',
            splitDown: 'Add panel below',
            splitUp: 'Add panel above',
            closePanel: 'Close panel',
            dropVariableHere: 'Drop a variable here',
            dropToAddTrace: 'Drop to add another variable',

            // Plot panel buttons
            modeTimeseries: 'Time series',
            modePhase2d: 'Phase 2D',
            modePhase2dt: 'Phase 2D + time',
            modePhase3d: 'Phase 3D',
            viewHome: 'Home view',
            viewTop: 'Top view (XY plane)',
            viewFront: 'Front view (XZ plane)',
            viewSide: 'Side view (YZ plane)',
            view2dtXt: 'X vs time plane',
            view2dtYt: 'Y vs time plane',
            view2dtXY: 'Phase portrait (X vs Y)',
            clearPlot: 'Clear plot',
            exportCsv: 'Export as CSV',
            projIsometric: 'Isometric projection (click for perspective)',
            projPerspective: 'Perspective projection (click for isometric)',

            // Dialogs
            loadNewFileWarning: 'Loading a new file will clear the current visualization. Continue?',
            resetLayoutWarning: 'This will reset the panel layout. Continue?',
            legendPosition: 'Legend',
            legendOverlay: 'Overlay (top-left)',
            legendBelow: 'Above plot',
            legendRight: 'Right of plot',
            confirm: 'Confirm',
            cancel: 'Cancel',

            // Help modal
            helpTitle: 'Help — OpenModelica & Dymola Result Viewer',
            helpClose: 'Close',
            helpSec1Title: 'Purpose',
            helpSec1Body: 'This application opens simulation result files in <b>.mat</b> format produced by <b>OpenModelica</b> and <b>Dymola</b>. Both simulators store time-series results in the same binary MAT v4 format.<br>Load a file by dragging it onto the drop zone, or by clicking the <b>📂</b> button in the top bar. Reload the active file at any time with <b>🔄</b>.',
            helpSec2Title: 'Plot types',
            helpSec2Body: 'Drag variables from the sidebar onto any panel. All modes support multiple traces in the same panel — keep dragging to add more.<ul><li><b>Time series (📈)</b> — one or more variables plotted against time. Each dragged variable adds a new trace.</li><li><b>Phase 2D</b> — two variables plotted against each other (X vs Y). Drop X first, then Y. Each X/Y pair creates a new trace.</li><li><b>Phase 2D+t</b> — same as Phase 2D but time is shown as the third axis, producing a 3D curve in space.</li><li><b>Phase 3D</b> — three variables in 3D space. Drop X, then Y, then Z. Each triplet creates a new trace.</li></ul>',
            helpSec3Title: 'Where to find result files',
            helpSec3Body: '<b>OpenModelica (Windows):</b> result files (named <code>ModelName_res.mat</code>) are saved in the working directory. In OMEdit, go to <i>Tools → Options → General → Working Directory</i> to see or change it.<br><br><b>Dymola (Windows):</b> the result file (default name <code>dsres.mat</code>) is saved in the current working directory, shown at the bottom of the Dymola window. Change it via <i>File → Change Directory</i>.',
            helpSec4Title: 'Multiple files',
            helpSec4Body: 'Click <b>📂</b> to add more files without closing existing ones. All loaded files appear in the <b>Files</b> panel at the top of the sidebar. Click a file name to make it active — its variables will appear in the sidebar for dragging. You can mix traces from different files in the same panel. When two or more files are loaded, the file name appears in brackets in the legend of each trace.'
        },

        fr: {
            // App title
            appTitle: 'Visualiseur de résultats OpenModelica',

            // Top bar
            variables: 'Variables',
            layout: 'Configuration de disposition',
            options: 'Options',
            rows: 'Lignes',
            columns: 'Colonnes',
            apply: 'Appliquer',
            showDescriptions: 'Afficher les descriptions',
            linkTimeAxes: 'Lier les axes temporels',
            syncHover: 'Survol synchronisé',

            // Drop zone
            dragFile: 'Glissez-déposez un fichier .mat ici',
            or: 'ou',
            selectFile: 'Sélectionner un fichier',

            // Messages
            fileLoaded: 'Fichier chargé avec succès',
            errorLoading: 'Erreur de chargement du fichier',
            invalidFile: 'Fichier .mat invalide',

            // Tree
            component: 'Composant',
            variable: 'Variable',
            parameter: 'Paramètre',

            // Tooltips
            toggleSidebar: 'Afficher/masquer le panneau latéral',
            autoZoom: 'Ajustement automatique de tous les graphiques',
            clearPlots: 'Effacer tous les graphiques',
            reloadFile: 'Recharger le fichier',
            toggleTheme: 'Changer de thème',
            loadNewFile: 'Charger un nouveau fichier',
            toggleDescriptions: 'Afficher/masquer les descriptions',
            expandAll: 'Tout développer',
            collapseAll: 'Tout réduire',
            resetLayout: 'Réinitialiser la disposition',
            help: 'Aide',
            loadExample: 'Charger l\'exemple',
            loadExampleWarning: 'Charger l\'exemple réinitialisera la disposition et effacera tous les graphiques. Les fichiers chargés resteront. Continuer ?',
            files: 'Fichiers',
            closeFile: 'Supprimer le fichier',
            closeFileWarning: 'Ce fichier a des graphiques chargés. Le supprimer effacera ces graphiques. Continuer ?',

            // Layout panels
            layout: 'Disposition',
            layoutHint: 'Survolez un panneau pour afficher les boutons diviser (◀▶ / ▲▼) et fermer (✕).',
            splitRight: 'Ajouter un panneau à droite',
            splitLeft: 'Ajouter un panneau à gauche',
            splitDown: 'Ajouter un panneau en bas',
            splitUp: 'Ajouter un panneau en haut',
            closePanel: 'Fermer le panneau',
            dropVariableHere: 'Déposez une variable ici',
            dropToAddTrace: 'Déposer pour ajouter une variable',

            // Plot panel buttons
            modeTimeseries: 'Série temporelle',
            modePhase2d: 'Phase 2D',
            modePhase2dt: 'Phase 2D + temps',
            modePhase3d: 'Phase 3D',
            viewHome: 'Vue d\'ensemble',
            viewTop: 'Vue de dessus (plan XY)',
            viewFront: 'Vue de face (plan XZ)',
            viewSide: 'Vue de côté (plan YZ)',
            view2dtXt: 'Plan X vs temps',
            view2dtYt: 'Plan Y vs temps',
            view2dtXY: 'Portrait de phase (X vs Y)',
            clearPlot: 'Effacer le graphique',
            exportCsv: 'Exporter en CSV',
            projIsometric: 'Projection isométrique (cliquer pour perspective)',
            projPerspective: 'Projection en perspective (cliquer pour isométrique)',

            // Dialogs
            loadNewFileWarning: 'Charger un nouveau fichier effacera la visualisation actuelle. Continuer ?',
            resetLayoutWarning: 'Cela réinitialisera la disposition des panneaux. Continuer ?',
            legendPosition: 'Légende',
            legendOverlay: 'Superposée (haut-gauche)',
            legendBelow: 'Au-dessus du graphique',
            legendRight: 'À droite du graphique',
            confirm: 'Confirmer',
            cancel: 'Annuler',

            helpTitle: 'Aide — Visualiseur de résultats OpenModelica & Dymola',
            helpClose: 'Fermer',
            helpSec1Title: 'Objectif',
            helpSec1Body: 'Cette application ouvre les fichiers de résultats de simulation au format <b>.mat</b> produits par <b>OpenModelica</b> et <b>Dymola</b>. Les deux simulateurs stockent les résultats temporels dans le même format binaire MAT v4.<br>Chargez un fichier en le faisant glisser sur la zone de dépôt, ou en cliquant sur le bouton <b>📂</b> dans la barre supérieure. Rechargez le fichier actif à tout moment avec <b>🔄</b>.',
            helpSec2Title: 'Types de graphiques',
            helpSec2Body: 'Faites glisser les variables depuis la barre latérale vers un panneau. Tous les modes supportent plusieurs traces dans le même panneau.<ul><li><b>Série temporelle (📈)</b> — une ou plusieurs variables en fonction du temps. Chaque variable glissée ajoute une trace.</li><li><b>Phase 2D</b> — deux variables représentées l\'une en fonction de l\'autre (X vs Y). Déposez X en premier, puis Y. Chaque paire crée une trace.</li><li><b>Phase 2D+t</b> — identique à Phase 2D, mais le temps est affiché comme troisième axe (courbe 3D dans l\'espace).</li><li><b>Phase 3D</b> — trois variables dans un espace 3D. Déposez X, puis Y, puis Z. Chaque triplet crée une trace.</li></ul>',
            helpSec3Title: 'Où trouver les fichiers de résultats',
            helpSec3Body: '<b>OpenModelica (Windows) :</b> les fichiers de résultats (nommés <code>NomDuModèle_res.mat</code>) sont enregistrés dans le répertoire de travail. Dans OMEdit, allez dans <i>Outils → Options → Général → Répertoire de travail</i> pour le voir ou le modifier.<br><br><b>Dymola (Windows) :</b> le fichier de résultats (nom par défaut <code>dsres.mat</code>) est enregistré dans le répertoire de travail courant, affiché en bas de la fenêtre Dymola. Modifiez-le via <i>Fichier → Changer de répertoire</i>.',
            helpSec4Title: 'Plusieurs fichiers simultanés',
            helpSec4Body: 'Cliquez sur <b>📂</b> pour ajouter d\'autres fichiers sans fermer les précédents. Tous les fichiers chargés apparaissent dans le panneau <b>Fichiers</b> en haut de la barre latérale. Cliquez sur un nom de fichier pour le rendre actif — ses variables apparaîtront dans la barre latérale. Vous pouvez mélanger des variables de différents fichiers dans le même panneau. Lorsque deux fichiers ou plus sont chargés, le nom du fichier est indiqué entre crochets dans la légende de chaque trace.'
        },

        es: {
            // App title
            appTitle: 'Visor de resultados OpenModelica',

            // Top bar
            variables: 'Variables',
            layout: 'Configuración de diseño',
            options: 'Opciones',
            rows: 'Filas',
            columns: 'Columnas',
            apply: 'Aplicar',
            showDescriptions: 'Mostrar descripciones',
            linkTimeAxes: 'Vincular ejes de tiempo',
            syncHover: 'Hover sincronizado',

            // Drop zone
            dragFile: 'Arrastra un archivo .mat aquí',
            or: 'o',
            selectFile: 'Seleccionar archivo',

            // Messages
            fileLoaded: 'Archivo cargado con éxito',
            errorLoading: 'Error al cargar el archivo',
            invalidFile: 'Archivo .mat inválido',

            // Tree
            component: 'Componente',
            variable: 'Variable',
            parameter: 'Parámetro',

            // Tooltips
            toggleSidebar: 'Mostrar/ocultar panel lateral',
            autoZoom: 'Ajuste automático de todos los gráficos',
            clearPlots: 'Limpiar todos los gráficos',
            reloadFile: 'Recargar archivo',
            toggleTheme: 'Cambiar tema',
            loadNewFile: 'Cargar nuevo archivo',
            toggleDescriptions: 'Mostrar/ocultar descripciones',
            expandAll: 'Expandir todo',
            collapseAll: 'Contraer todo',
            resetLayout: 'Reiniciar diseño',
            help: 'Ayuda',
            loadExample: 'Cargar ejemplo',
            loadExampleWarning: 'Cargar el ejemplo restablecerá el diseño y borrará todos los gráficos. Los archivos cargados permanecerán. ¿Continuar?',
            files: 'Archivos',
            closeFile: 'Eliminar archivo',
            closeFileWarning: 'Este archivo tiene gráficos cargados. Eliminarlo borrará esos gráficos. ¿Continuar?',

            // Layout panels
            layout: 'Diseño',
            layoutHint: 'Pasa el cursor sobre un panel para ver los botones de dividir (◀▶ / ▲▼) y cerrar (✕).',
            splitRight: 'Agregar panel a la derecha',
            splitLeft: 'Agregar panel a la izquierda',
            splitDown: 'Agregar panel abajo',
            splitUp: 'Agregar panel arriba',
            closePanel: 'Cerrar panel',
            dropVariableHere: 'Arrastra una variable aquí',
            dropToAddTrace: 'Arrastra para añadir otra variable',

            // Plot panel buttons
            modeTimeseries: 'Serie temporal',
            modePhase2d: 'Fase 2D',
            modePhase2dt: 'Fase 2D + tiempo',
            modePhase3d: 'Fase 3D',
            viewHome: 'Vista inicial',
            viewTop: 'Vista superior (plano XY)',
            viewFront: 'Vista frontal (plano XZ)',
            viewSide: 'Vista lateral (plano YZ)',
            view2dtXt: 'Plano X vs tiempo',
            view2dtYt: 'Plano Y vs tiempo',
            view2dtXY: 'Retrato de fase (X vs Y)',
            clearPlot: 'Limpiar gráfico',
            exportCsv: 'Exportar como CSV',
            projIsometric: 'Proyección isométrica (clic para perspectiva)',
            projPerspective: 'Proyección en perspectiva (clic para isométrica)',

            // Dialogs
            loadNewFileWarning: 'Cargar un nuevo archivo eliminará la visualización actual. ¿Continuar?',
            resetLayoutWarning: 'Esto reiniciará el diseño de paneles. ¿Continuar?',
            legendPosition: 'Leyenda',
            legendOverlay: 'Superpuesta (arriba-izquierda)',
            legendBelow: 'Encima del gráfico',
            legendRight: 'A la derecha del gráfico',
            confirm: 'Confirmar',
            cancel: 'Cancelar',

            helpTitle: 'Ayuda — Visor de resultados OpenModelica & Dymola',
            helpClose: 'Cerrar',
            helpSec1Title: 'Propósito',
            helpSec1Body: 'Esta aplicación abre archivos de resultados de simulación en formato <b>.mat</b> producidos por <b>OpenModelica</b> y <b>Dymola</b>. Ambos simuladores almacenan resultados de series temporales en el mismo formato binario MAT v4.<br>Cargue un archivo arrastrándolo a la zona de descarga, o haciendo clic en el botón <b>📂</b> de la barra superior. Recargue el archivo activo en cualquier momento con <b>🔄</b>.',
            helpSec2Title: 'Tipos de gráficos',
            helpSec2Body: 'Arrastre variables desde la barra lateral hacia cualquier panel. Todos los modos admiten múltiples trazas en el mismo panel.<ul><li><b>Serie temporal (📈)</b> — una o más variables en función del tiempo. Cada variable arrastrada agrega una traza.</li><li><b>Fase 2D</b> — dos variables representadas entre sí (X vs Y). Suelte primero X, luego Y. Cada par crea una traza.</li><li><b>Fase 2D+t</b> — igual que Fase 2D, pero el tiempo se muestra como tercer eje (curva 3D en el espacio).</li><li><b>Fase 3D</b> — tres variables en un espacio 3D. Suelte X, luego Y, luego Z. Cada triplete crea una traza.</li></ul>',
            helpSec3Title: 'Dónde encontrar los archivos de resultados',
            helpSec3Body: '<b>OpenModelica (Windows):</b> los archivos de resultados (llamados <code>NombreDelModelo_res.mat</code>) se guardan en el directorio de trabajo. En OMEdit, vaya a <i>Herramientas → Opciones → General → Directorio de trabajo</i> para verlo o cambiarlo.<br><br><b>Dymola (Windows):</b> el archivo de resultados (nombre por defecto <code>dsres.mat</code>) se guarda en el directorio de trabajo actual, mostrado en la parte inferior de la ventana de Dymola. Cámbielo mediante <i>Archivo → Cambiar directorio</i>.',
            helpSec4Title: 'Múltiples archivos simultáneos',
            helpSec4Body: 'Haga clic en <b>📂</b> para agregar más archivos sin cerrar los actuales. Todos los archivos cargados aparecen en el panel <b>Archivos</b> en la parte superior de la barra lateral. Haga clic en un nombre de archivo para activarlo — sus variables aparecerán en la barra lateral. Puede mezclar variables de diferentes archivos en el mismo panel. Cuando se cargan dos o más archivos, el nombre del archivo aparece entre corchetes en la leyenda de cada traza.'
        },

        it: {
            // App title
            appTitle: 'Visualizzatore risultati OpenModelica',

            // Top bar
            variables: 'Variabili',
            layout: 'Layout',
            options: 'Opzioni',
            rows: 'Righe',
            columns: 'Colonne',
            apply: 'Applica',
            showDescriptions: 'Mostra descrizioni',
            linkTimeAxes: 'Collega assi temporali',
            syncHover: 'Hover sincronizzato',

            // Drop zone
            dragFile: 'Trascina un file .mat qui',
            or: 'oppure',
            selectFile: 'Seleziona file',

            // Messages
            fileLoaded: 'File caricato con successo',
            errorLoading: 'Errore nel caricamento del file',
            invalidFile: 'File .mat non valido',

            // Tree
            component: 'Componente',
            variable: 'Variabile',
            parameter: 'Parametro',

            // Tooltips
            toggleSidebar: 'Mostra/nascondi pannello laterale',
            autoZoom: 'Adattamento automatico di tutti i grafici',
            clearPlots: 'Cancella tutti i grafici',
            reloadFile: 'Ricarica file',
            toggleTheme: 'Cambia tema',
            loadNewFile: 'Carica nuovo file',
            toggleDescriptions: 'Mostra/nascondi descrizioni',
            expandAll: 'Espandi tutto',
            collapseAll: 'Comprimi tutto',
            resetLayout: 'Reimposta layout',
            help: 'Guida',
            loadExample: 'Carica esempio',
            loadExampleWarning: 'Caricare l\'esempio reimposterà il layout e cancellerà tutti i grafici. I file caricati rimarranno. Continuare?',
            files: 'File',
            closeFile: 'Rimuovi file',
            closeFileWarning: 'Questo file ha grafici caricati. Rimuoverlo cancellerà quei grafici. Continuare?',

            // Layout panels
            layout: 'Layout',
            layoutHint: 'Passa il cursore su un pannello per visualizzare i pulsanti dividi (◀▶ / ▲▼) e chiudi (✕).',
            splitRight: 'Aggiungi pannello a destra',
            splitLeft: 'Aggiungi pannello a sinistra',
            splitDown: 'Aggiungi pannello in basso',
            splitUp: 'Aggiungi pannello in alto',
            closePanel: 'Chiudi pannello',
            dropVariableHere: 'Trascina una variabile qui',
            dropToAddTrace: 'Trascina per aggiungere un\'altra variabile',

            // Plot panel buttons
            modeTimeseries: 'Serie temporale',
            modePhase2d: 'Fase 2D',
            modePhase2dt: 'Fase 2D + tempo',
            modePhase3d: 'Fase 3D',
            viewHome: 'Vista iniziale',
            viewTop: 'Vista dall\'alto (piano XY)',
            viewFront: 'Vista frontale (piano XZ)',
            viewSide: 'Vista laterale (piano YZ)',
            view2dtXt: 'Piano X vs tempo',
            view2dtYt: 'Piano Y vs tempo',
            view2dtXY: 'Ritratto di fase (X vs Y)',
            clearPlot: 'Cancella grafico',
            exportCsv: 'Esporta come CSV',
            projIsometric: 'Proiezione isometrica (clic per prospettiva)',
            projPerspective: 'Proiezione prospettica (clic per isometrica)',

            // Dialogs
            loadNewFileWarning: 'Caricare un nuovo file cancellerà la visualizzazione corrente. Continuare?',
            resetLayoutWarning: 'Questo reimposterà il layout dei pannelli. Continuare?',
            legendPosition: 'Legenda',
            legendOverlay: 'Sovrapposta (in alto a sinistra)',
            legendBelow: 'Sopra il grafico',
            legendRight: 'A destra del grafico',
            confirm: 'Conferma',
            cancel: 'Annulla',

            helpTitle: 'Guida — Visualizzatore risultati OpenModelica & Dymola',
            helpClose: 'Chiudi',
            helpSec1Title: 'Scopo',
            helpSec1Body: 'Questa applicazione apre file di risultati di simulazione in formato <b>.mat</b> prodotti da <b>OpenModelica</b> e <b>Dymola</b>. Entrambi i simulatori memorizzano i risultati delle serie temporali nello stesso formato binario MAT v4.<br>Caricare un file trascinandolo nella zona di rilascio, oppure facendo clic sul pulsante <b>📂</b> nella barra superiore. Ricaricare il file attivo in qualsiasi momento con <b>🔄</b>.',
            helpSec2Title: 'Tipi di grafici',
            helpSec2Body: 'Trascinare le variabili dalla barra laterale su qualsiasi pannello. Tutti i modi supportano più tracce nello stesso pannello.<ul><li><b>Serie temporale (📈)</b> — una o più variabili in funzione del tempo. Ogni variabile trascinata aggiunge una traccia.</li><li><b>Fase 2D</b> — due variabili rappresentate l\'una in funzione dell\'altra (X vs Y). Rilasciare prima X, poi Y. Ogni coppia crea una traccia.</li><li><b>Fase 2D+t</b> — uguale a Fase 2D, ma il tempo è mostrato come terzo asse (curva 3D nello spazio).</li><li><b>Fase 3D</b> — tre variabili in uno spazio 3D. Rilasciare X, poi Y, poi Z. Ogni terzetto crea una traccia.</li></ul>',
            helpSec3Title: 'Dove trovare i file di risultati',
            helpSec3Body: '<b>OpenModelica (Windows):</b> i file di risultati (denominati <code>NomeModello_res.mat</code>) vengono salvati nella directory di lavoro. In OMEdit, andare su <i>Strumenti → Opzioni → Generale → Directory di lavoro</i> per vederla o modificarla.<br><br><b>Dymola (Windows):</b> il file di risultati (nome predefinito <code>dsres.mat</code>) viene salvato nella directory di lavoro corrente, mostrata nella parte inferiore della finestra di Dymola. Modificarla tramite <i>File → Cambia directory</i>.',
            helpSec4Title: 'File multipli simultanei',
            helpSec4Body: 'Fare clic su <b>📂</b> per aggiungere altri file senza chiudere quelli esistenti. Tutti i file caricati appaiono nel pannello <b>File</b> in cima alla barra laterale. Fare clic su un nome di file per renderlo attivo — le sue variabili appariranno nella barra laterale. È possibile combinare variabili di file diversi nello stesso pannello. Quando sono caricati due o più file, il nome del file viene mostrato tra parentesi nella legenda di ogni traccia.'
        }
    },

    /**
     * Set the current language
     */
    setLanguage(lang) {
        if (!this.translations[lang]) {
            console.warn(`Language ${lang} not found, defaulting to 'en'`);
            lang = 'en';
        }
        this.currentLang = lang;
        this.updateDOM();
    },

    /**
     * Get a translation key
     */
    t(key) {
        return this.translations[this.currentLang][key] || key;
    },

    /**
     * Update all elements with data-i18n attribute
     */
    updateDOM() {
        const elements = document.querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = this.t(key);

            // Update text content or placeholder
            if (el.tagName === 'INPUT' && el.type === 'text') {
                el.placeholder = translation;
            } else {
                el.textContent = translation;
            }
        });

        // Update tooltips
        const tooltips = {
            'toggle-sidebar':     'toggleSidebar',
            'auto-zoom':          'autoZoom',
            'clear-plots':        'clearPlots',
            'reload-file':        'reloadFile',
            'load-new-file':      'loadNewFile',
            'theme-toggle':       'toggleTheme',
            'toggle-descriptions':'toggleDescriptions',
            'expand-all':         'expandAll',
            'collapse-all':       'collapseAll',
            'reset-layout':       'resetLayout',
            'load-example-btn':   'loadExample',
            'help-btn':           'help',
        };

        for (const [id, key] of Object.entries(tooltips)) {
            const el = document.getElementById(id);
            if (el) el.title = this.t(key);
        }

        // Update browser title tab
        document.title = this.t('appTitle');
    }
};
