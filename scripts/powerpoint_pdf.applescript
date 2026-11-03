on run argv
    set sourceFile to POSIX file (item 1 of argv)
    set targetFile to POSIX file (item 2 of argv)
    set sourceName to item 3 of argv
    tell application "Microsoft PowerPoint"
        try
            with timeout of 75 seconds
                open sourceFile
                set sourceDoc to presentation sourceName
                save sourceDoc in targetFile as save as PDF
                close sourceDoc saving no
            end timeout
        on error errorText number errorNumber
            with timeout of 10 seconds
                try
                    close presentation sourceName saving no
                end try
            end timeout
            error errorText number errorNumber
        end try
    end tell
end run
