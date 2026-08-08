function url = channelChooserURL(configFile, varargin)
% Open the channel chooser web app with a microscope config from disk
%
% function url = channelChooserURL(configFile)
% function url = channelChooserURL(configFile, 'site', siteURL, 'open', false)
%
% Purpose
% Hands a microscope configuration to the two-photon channel chooser so the
% user lands on their own rig instead of a generic one. The config travels in
% the URL fragment, base64url-encoded, which means it never leaves the machine:
% fragments are not sent to the server. The page decodes it, loads that
% microscope, and remembers it for next time.
%
% This is a reference implementation for BakingTray to call from a menu item.
% Nothing here is specific to BakingTray - it just needs a config file.
%
% Inputs
% configFile - path to a microscope config JSON, as written by the "Save
%              config" button in the web app. Keep these in the BakingTray
%              SETTINGS directory.
% 'site'     - base URL of the app. Defaults to the SWC deployment.
% 'open'     - true (default) opens the system browser. false just returns
%              the URL, which is handy for testing.
%
% Outputs
% url - the full URL, whether or not it was opened.
%
% Example
% channelChooserURL(fullfile(BakingTray.settings.settingsLocation, 'brainsaw_1.json'))
%
%
% Rob Campbell - SWC AMF


    params = inputParser;
    params.addParameter('site', 'https://swcmicroscopy.com/channel-chooser/', @ischar);
    params.addParameter('open', true, @(x) islogical(x) || isnumeric(x));
    params.parse(varargin{:});

    if nargin < 1 || isempty(configFile)
        error('channelChooserURL requires the path to a microscope config file')
    end

    if ~exist(configFile, 'file')
        error('No such config file: %s', configFile)
    end

    % Read it as text and check it is the right sort of thing before we send
    % anyone to a page with a broken config in the URL.
    fid = fopen(configFile, 'r');
    txt = fread(fid, '*char')';
    fclose(fid);

    cfg = jsondecode(txt);
    if ~isfield(cfg, 'channels') || isempty(cfg.channels)
        error('%s does not look like a microscope config: no channels field', configFile)
    end

    % Compact it: the URL is shorter and the content is identical.
    txt = jsonencode(cfg);

    url = [params.Results.site, '#cfg=', base64url(txt)];

    if params.Results.open
        web(url, '-browser');
    end

end % channelChooserURL


function out = base64url(txt)
    % base64url, unpadded - the encoding the web app expects
    bytes = unicode2native(txt, 'UTF-8');
    encoder = java.util.Base64.getUrlEncoder().withoutPadding();
    out = char(encoder.encodeToString(typecast(bytes(:)', 'int8')));
end
